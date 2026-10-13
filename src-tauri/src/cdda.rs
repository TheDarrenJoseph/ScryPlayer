//! Audio CD table-of-contents and raw-sector reading.
//!
//! Deliberately free of `tauri` types, same as `media.rs`, so the SCSI
//! command-building, TOC-parsing and WAV-header logic here is unit testable
//! without a drive. Only `send_scsi`, dispatched to a platform module below,
//! actually touches the OS — on Linux via `cdda_linux`; any other target
//! gets a stub that reports the platform isn't supported yet, so the crate
//! always compiles and a new platform module is the only thing a later port
//! needs to add.
//!
//! The commands themselves (`READ TOC/PMA/ATIP`, `READ CD`) are standard SCSI
//! MMC opcodes — the same bytes regardless of OS. Only the transport that
//! submits them differs: Linux's `SG_IO` ioctl here, Windows's
//! `IOCTL_SCSI_PASS_THROUGH_DIRECT` later.

use serde::Serialize;

/// Bytes per raw CD-DA sector: 44.1kHz * 16-bit * stereo / 75 sectors-per-second.
pub const SECTOR_BYTES: u32 = 2352;
pub const SECTORS_PER_SECOND: u32 = 75;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CdTrack {
    pub track_no: u32,
    pub start_lba: u32,
    /// Exclusive — the next track's start, or the lead-out for the last track.
    pub end_lba: u32,
    pub duration: f64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Toc {
    pub tracks: Vec<CdTrack>,
}

/// `READ TOC/PMA/ATIP` (opcode 0x43), format 0 (plain TOC), LBA addressing.
fn read_toc_cdb() -> [u8; 10] {
    let mut cdb = [0u8; 10];
    cdb[0] = 0x43;
    // Byte 1 bit 1 (MSF) left clear: addresses come back as LBA, not MSF.
    // Byte 2 low nibble (format) left at 0: plain TOC.
    cdb[6] = 1; // starting track number
    let alloc_len: u16 = 1024; // comfortably more than any real disc's TOC
    cdb[7] = (alloc_len >> 8) as u8;
    cdb[8] = (alloc_len & 0xff) as u8;
    cdb
}

/// `READ CD` (opcode 0xBE): CD-DA sector type, user data only, so each
/// returned sector is exactly the raw 2352-byte frame already on the disc.
fn read_cd_cdb(start_lba: u32, sector_count: u32) -> [u8; 12] {
    let mut cdb = [0u8; 12];
    cdb[0] = 0xBE;
    cdb[1] = 1 << 2; // expected sector type = CD-DA
    cdb[2..6].copy_from_slice(&start_lba.to_be_bytes());
    let len = sector_count.to_be_bytes();
    cdb[6..9].copy_from_slice(&len[1..4]); // 3-byte big-endian transfer length
    cdb[9] = 0x10; // bit 4: return user data only
    cdb
}

/// Parse a format-0 `READ TOC` response into track boundaries.
///
/// After the 4-byte header, each 8-byte descriptor is `(reserved, adr<<4 |
/// control, track_no, reserved, lba[4])`. The lead-out descriptor (track
/// 0xAA) carries no track of its own — it only supplies the real last
/// track's end boundary. A track's end is simply the LBA of whatever
/// descriptor follows it, lead-out included. Data tracks (control bit 0x04
/// set) are dropped; only audio belongs in a playback queue.
pub fn parse_toc(data: &[u8]) -> Result<Toc, String> {
    if data.len() < 4 {
        return Err("TOC response too short".into());
    }

    let mut entries: Vec<(u8, u32, bool)> = Vec::new(); // (track_no, lba, is_data)
    let mut i = 4;
    while i + 8 <= data.len() {
        let control = data[i + 1] & 0x0f;
        let track_no = data[i + 2];
        let lba = u32::from_be_bytes([data[i + 4], data[i + 5], data[i + 6], data[i + 7]]);
        entries.push((track_no, lba, control & 0x04 != 0));
        i += 8;
    }

    let mut tracks = Vec::new();
    for idx in 0..entries.len() {
        let (track_no, start_lba, is_data) = entries[idx];
        if track_no == 0xAA || is_data {
            continue;
        }
        let Some(&(_, end_lba, _)) = entries.get(idx + 1) else {
            continue; // malformed response: a real track with no boundary after it
        };
        let sectors = end_lba.saturating_sub(start_lba);
        tracks.push(CdTrack {
            track_no: track_no as u32,
            start_lba,
            end_lba,
            duration: sectors as f64 / SECTORS_PER_SECOND as f64,
        });
    }

    Ok(Toc { tracks })
}

/// The 44-byte canonical PCM WAV header for `sector_count` raw CDDA sectors.
/// CDDA is already 44.1kHz/16-bit/stereo, so this is pure bookkeeping — no
/// decoding happens anywhere in this pipeline.
pub fn wav_header(sector_count: u32) -> [u8; 44] {
    let data_len = sector_count * SECTOR_BYTES;
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_len).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&2u16.to_le_bytes()); // stereo
    h[24..28].copy_from_slice(&44_100u32.to_le_bytes());
    h[28..32].copy_from_slice(&(44_100 * 4u32).to_le_bytes()); // byte rate
    h[32..34].copy_from_slice(&4u16.to_le_bytes()); // block align
    h[34..36].copy_from_slice(&16u16.to_le_bytes()); // bits per sample
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_len.to_le_bytes());
    h
}

/// Total bytes the `/cdda` route serves for a track spanning these sectors:
/// the 44-byte header plus raw PCM.
pub fn stream_len(start_lba: u32, end_lba: u32) -> u64 {
    44 + (end_lba - start_lba) as u64 * SECTOR_BYTES as u64
}

// ---- OS dispatch ------------------------------------------------------------

#[cfg(target_os = "linux")]
use crate::cdda_linux as platform;

#[cfg(not(target_os = "linux"))]
mod platform {
    use super::DriveInfo;

    pub fn list_drives() -> Vec<DriveInfo> {
        Vec::new()
    }

    pub fn send_scsi(_device: &str, _cdb: &[u8], _out_len: usize) -> Result<Vec<u8>, String> {
        Err("Audio CD playback isn't supported on this platform yet".into())
    }
}

pub fn list_drives() -> Vec<DriveInfo> {
    platform::list_drives()
}

pub fn read_toc(device: &str) -> Result<Toc, String> {
    let cdb = read_toc_cdb();
    let data = platform::send_scsi(device, &cdb, 1024)?;
    parse_toc(&data)
}

pub fn read_sectors(device: &str, start_lba: u32, count: u32) -> Result<Vec<u8>, String> {
    let cdb = read_cd_cdb(start_lba, count);
    platform::send_scsi(device, &cdb, (count * SECTOR_BYTES) as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(track_no: u8, control: u8, lba: u32) -> [u8; 8] {
        let mut d = [0u8; 8];
        d[1] = control;
        d[2] = track_no;
        d[4..8].copy_from_slice(&lba.to_be_bytes());
        d
    }

    #[test]
    fn parses_a_two_track_audio_toc() {
        let mut data = vec![0u8, 0, 1, 2]; // header: length, first=1, last=2
        data.extend(descriptor(1, 0x00, 0));
        data.extend(descriptor(2, 0x00, 21_000));
        data.extend(descriptor(0xAA, 0x00, 45_000)); // lead-out

        let toc = parse_toc(&data).unwrap();
        assert_eq!(
            toc.tracks,
            vec![
                CdTrack { track_no: 1, start_lba: 0, end_lba: 21_000, duration: 21_000.0 / 75.0 },
                CdTrack { track_no: 2, start_lba: 21_000, end_lba: 45_000, duration: 24_000.0 / 75.0 },
            ]
        );
    }

    #[test]
    fn skips_data_tracks() {
        let mut data = vec![0u8, 0, 1, 2];
        data.extend(descriptor(1, 0x00, 0));
        data.extend(descriptor(2, 0x04, 21_000)); // data track
        data.extend(descriptor(0xAA, 0x00, 45_000));

        let toc = parse_toc(&data).unwrap();
        assert_eq!(toc.tracks.len(), 1);
        assert_eq!(toc.tracks[0].track_no, 1);
    }

    #[test]
    fn rejects_a_too_short_response() {
        assert!(parse_toc(&[0, 0]).is_err());
    }

    #[test]
    fn wav_header_reports_correct_lengths() {
        let h = wav_header(100);
        let data_len = 100 * SECTOR_BYTES;
        assert_eq!(&h[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(h[4..8].try_into().unwrap()), 36 + data_len);
        assert_eq!(&h[8..12], b"WAVE");
        assert_eq!(&h[36..40], b"data");
        assert_eq!(u32::from_le_bytes(h[40..44].try_into().unwrap()), data_len);
    }

    #[test]
    fn stream_len_is_header_plus_pcm() {
        assert_eq!(stream_len(0, 100), 44 + 100 * SECTOR_BYTES as u64);
    }

    #[test]
    fn builds_read_cd_cdb() {
        let cdb = read_cd_cdb(0x0001_0203, 5);
        assert_eq!(cdb[0], 0xBE);
        assert_eq!(&cdb[2..6], &[0x00, 0x01, 0x02, 0x03]);
        assert_eq!(&cdb[6..9], &[0x00, 0x00, 0x05]);
        assert_eq!(cdb[9], 0x10);
    }

    #[test]
    fn builds_read_toc_cdb() {
        let cdb = read_toc_cdb();
        assert_eq!(cdb[0], 0x43);
        assert_eq!(cdb[6], 1);
        assert_eq!(&cdb[7..9], &[0x04, 0x00]); // 1024, big-endian
    }
}
