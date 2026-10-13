//! Linux SCSI-generic (`SG_IO`) transport for reading an audio CD.
//!
//! This is the same ioctl mechanism `cdparanoia`/`cdrecord` use, issued
//! straight against the `/dev/sr*` block device node — no separate
//! `/dev/sg*` node is needed, and it works against the USB external drives
//! most current machines actually have, unlike the older ATAPI-only
//! `CDROMREADAUDIO` ioctl.

use std::ffi::CString;
use std::fs;
use std::os::unix::io::RawFd;

use super::DriveInfo;

const SG_IO: libc::c_ulong = 0x2285;
const SG_DXFER_FROM_DEV: i32 = -3;
const SG_INTERFACE_ID_SCSI: i32 = b'S' as i32;

/// Mirrors Linux's `struct sg_io_hdr` (`<scsi/sg.h>`) field-for-field.
#[repr(C)]
struct SgIoHdr {
    interface_id: i32,
    dxfer_direction: i32,
    cmd_len: u8,
    mx_sb_len: u8,
    iovec_count: u16,
    dxfer_len: u32,
    dxferp: *mut libc::c_void,
    cmdp: *mut u8,
    sbp: *mut u8,
    timeout: u32,
    flags: u32,
    pack_id: i32,
    usr_ptr: *mut libc::c_void,
    status: u8,
    maskedstatus: u8,
    msg_status: u8,
    sb_len_wr: u8,
    host_status: u16,
    driver_status: u16,
    resid: i32,
    duration: u32,
    info: u32,
}

pub fn list_drives() -> Vec<DriveInfo> {
    let Ok(entries) = fs::read_dir("/dev") else {
        return Vec::new();
    };

    let mut drives: Vec<DriveInfo> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("sr") {
                return None;
            }
            let path = format!("/dev/{name}");
            Some(DriveInfo { id: path.clone(), label: path })
        })
        .collect();

    drives.sort_by(|a, b| a.id.cmp(&b.id));
    drives
}

fn open_device(device: &str) -> Result<RawFd, String> {
    let c_path = CString::new(device).map_err(|_| "invalid device path".to_string())?;
    // O_NONBLOCK: without it, opening a drive with no disc loaded blocks forever.
    let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_RDONLY | libc::O_NONBLOCK) };
    if fd < 0 {
        return Err(format!(
            "could not open {device}: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(fd)
}

pub fn send_scsi(device: &str, cdb: &[u8], out_len: usize) -> Result<Vec<u8>, String> {
    let fd = open_device(device)?;

    let mut cdb_buf = cdb.to_vec();
    let mut sense = [0u8; 32];
    let mut out = vec![0u8; out_len];

    let mut hdr = SgIoHdr {
        interface_id: SG_INTERFACE_ID_SCSI,
        dxfer_direction: SG_DXFER_FROM_DEV,
        cmd_len: cdb_buf.len() as u8,
        mx_sb_len: sense.len() as u8,
        iovec_count: 0,
        dxfer_len: out.len() as u32,
        dxferp: out.as_mut_ptr() as *mut libc::c_void,
        cmdp: cdb_buf.as_mut_ptr(),
        sbp: sense.as_mut_ptr(),
        timeout: 5000,
        flags: 0,
        pack_id: 0,
        usr_ptr: std::ptr::null_mut(),
        status: 0,
        maskedstatus: 0,
        msg_status: 0,
        sb_len_wr: 0,
        host_status: 0,
        driver_status: 0,
        resid: 0,
        duration: 0,
        info: 0,
    };

    let result = unsafe { libc::ioctl(fd, SG_IO as _, &mut hdr as *mut SgIoHdr) };
    unsafe { libc::close(fd) };

    if result < 0 {
        return Err(format!(
            "SCSI command to {device} failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    if hdr.status != 0 || hdr.driver_status != 0 {
        return Err(format!(
            "{device} rejected the SCSI command (status {}, driver status {})",
            hdr.status, hdr.driver_status
        ));
    }

    // The drive can return fewer bytes than requested (e.g. a short TOC);
    // `resid` is what's left over, so what's actually valid is the rest.
    let actual = out.len().saturating_sub(hdr.resid.max(0) as usize);
    out.truncate(actual);
    Ok(out)
}
