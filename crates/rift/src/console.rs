//! Native local terminal raw mode & Windows ConPTY keyboard compatibility helpers.
//!
//! Why this module exists:
//! 1. On Windows, `crossterm::terminal::enable_raw_mode()` clears line/echo/processed input
//!    flags, but does NOT enable `ENABLE_VIRTUAL_TERMINAL_INPUT` (`0x0200`). Without it,
//!    `ReadConsoleW` (`std::io::stdin().read()`) swallows `Esc`, arrow keys, `Home`/`End`,
//!    and degrades `Shift+Tab` to `\t`.
//! 2. Windows inbox ConPTY (`CreatePseudoConsole` -> `conhost.exe`) passes enhanced keyboard
//!    protocol requests (Kitty CSI-u `\x1b[>5u`, `modifyOtherKeys` `\x1b[>4;2m`,
//!    `win32-input-mode` `\x1b[?9001h`) straight through on output to outer Windows Terminal,
//!    causing WT to emit CSI-u / win32-input-mode sequences that inbox ConPTY then silently
//!    drops on input (breaking `Esc` and `Ctrl+C` in modern TUIs like `agy`).

#[cfg_attr(not(windows), allow(dead_code))]
pub const ENABLE_PROCESSED_INPUT: u32 = 0x0001;
#[cfg_attr(not(windows), allow(dead_code))]
pub const ENABLE_LINE_INPUT: u32 = 0x0002;
#[cfg_attr(not(windows), allow(dead_code))]
pub const ENABLE_ECHO_INPUT: u32 = 0x0004;
#[cfg_attr(not(windows), allow(dead_code))]
pub const ENABLE_WINDOW_INPUT: u32 = 0x0008;
#[cfg_attr(not(windows), allow(dead_code))]
pub const ENABLE_VIRTUAL_TERMINAL_INPUT: u32 = 0x0200;

#[cfg_attr(not(windows), allow(dead_code))]
pub const ENABLE_PROCESSED_OUTPUT: u32 = 0x0001;
#[cfg_attr(not(windows), allow(dead_code))]
pub const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;

/// Computes the Windows console input mode required for lossless VT passthrough.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn compute_win_raw_input_mode(orig: u32) -> u32 {
    let cleared = ENABLE_PROCESSED_INPUT
        | ENABLE_LINE_INPUT
        | ENABLE_ECHO_INPUT
        | ENABLE_WINDOW_INPUT;
    (orig & !cleared) | ENABLE_VIRTUAL_TERMINAL_INPUT
}

/// Computes the Windows console output mode required for ANSI/VT rendering.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn compute_win_raw_output_mode(orig: u32) -> u32 {
    orig | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING
}

#[cfg(windows)]
mod platform {
    use super::{compute_win_raw_input_mode, compute_win_raw_output_mode};
    use std::ffi::c_void;

    const STD_INPUT_HANDLE: u32 = (-10i32) as u32;
    const STD_OUTPUT_HANDLE: u32 = (-11i32) as u32;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(n_std_handle: u32) -> *mut c_void;
        fn GetConsoleMode(h_console_handle: *mut c_void, lp_mode: *mut u32) -> i32;
        fn SetConsoleMode(h_console_handle: *mut c_void, dw_mode: u32) -> i32;
    }

    /// Stores raw Win32 handles as `isize` so `RawConsoleGuard` remains `Send` on all targets.
    pub struct RawConsoleGuard {
        in_handle: Option<(isize, u32)>,
        out_handle: Option<(isize, u32)>,
    }

    impl RawConsoleGuard {
        pub fn enter(enable: bool) -> Self {
            if !enable {
                return Self {
                    in_handle: None,
                    out_handle: None,
                };
            }
            let mut in_saved = None;
            let mut out_saved = None;

            unsafe {
                let h_in = GetStdHandle(STD_INPUT_HANDLE);
                let h_in_raw = h_in as isize;
                if h_in_raw != 0 && h_in_raw != INVALID_HANDLE_VALUE {
                    let mut mode: u32 = 0;
                    if GetConsoleMode(h_in, &mut mode) != 0 {
                        let next = compute_win_raw_input_mode(mode);
                        if SetConsoleMode(h_in, next) != 0 {
                            in_saved = Some((h_in_raw, mode));
                        }
                    }
                }

                let h_out = GetStdHandle(STD_OUTPUT_HANDLE);
                let h_out_raw = h_out as isize;
                if h_out_raw != 0 && h_out_raw != INVALID_HANDLE_VALUE {
                    let mut mode: u32 = 0;
                    if GetConsoleMode(h_out, &mut mode) != 0 {
                        let next = compute_win_raw_output_mode(mode);
                        if SetConsoleMode(h_out, next) != 0 {
                            out_saved = Some((h_out_raw, mode));
                        }
                    }
                }
            }

            Self {
                in_handle: in_saved,
                out_handle: out_saved,
            }
        }
    }

    impl Drop for RawConsoleGuard {
        fn drop(&mut self) {
            unsafe {
                if let Some((h, mode)) = self.in_handle {
                    let _ = SetConsoleMode(h as *mut c_void, mode);
                }
                if let Some((h, mode)) = self.out_handle {
                    let _ = SetConsoleMode(h as *mut c_void, mode);
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub struct RawConsoleGuard(bool);

    impl RawConsoleGuard {
        pub fn enter(enable: bool) -> Self {
            if enable {
                let _ = crossterm::terminal::enable_raw_mode();
            }
            Self(enable)
        }
    }

    impl Drop for RawConsoleGuard {
        fn drop(&mut self) {
            if self.0 {
                let _ = crossterm::terminal::disable_raw_mode();
            }
        }
    }
}

pub use platform::RawConsoleGuard;

/// Streaming filter for Windows local stdout that strips keyboard-protocol upgrade
/// requests unsupported by inbox Windows ConPTY:
/// - Kitty keyboard protocol: `CSI > ... u`, `CSI = ... u`, `CSI < ... u`, `CSI ? u`
/// - XTerm modifyOtherKeys: `CSI > 4 ; ... m`, `CSI > 4 m`
/// - Win32 input mode: `CSI ? 9001 h/l` (including batched DECSET/DECRST like `CSI ? 2004;9001 h`)
///
/// All other ANSI/VT/OSC/DEC sequences (colors, cursor, DEC 2026, DECRQM, bracketed paste,
/// alt screen, titles, UTF-8) pass through untouched.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Default)]
pub struct WinOutputKeyboardFilter {
    pending: Vec<u8>,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl WinOutputKeyboardFilter {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    pub fn filter(&mut self, chunk: &[u8]) -> Vec<u8> {
        const MAX_PARAM_LEN: usize = 64;

        let mut combined;
        let data: &[u8] = if self.pending.is_empty() {
            chunk
        } else {
            combined = std::mem::take(&mut self.pending);
            combined.extend_from_slice(chunk);
            &combined
        };

        let mut out = Vec::with_capacity(data.len());
        let mut i = 0;

        while i < data.len() {
            if data[i] != 0x1b {
                let start = i;
                while i < data.len() && data[i] != 0x1b {
                    i += 1;
                }
                out.extend_from_slice(&data[start..i]);
                continue;
            }

            if i + 1 >= data.len() {
                self.pending.extend_from_slice(&data[i..]);
                break;
            }
            if data[i + 1] != b'[' {
                out.push(data[i]);
                i += 1;
                continue;
            }
            if i + 2 >= data.len() {
                self.pending.extend_from_slice(&data[i..]);
                break;
            }

            let prefix = data[i + 2];
            if !matches!(prefix, b'>' | b'=' | b'<' | b'?') {
                out.extend_from_slice(&data[i..i + 2]);
                i += 2;
                continue;
            }

            let mut j = i + 3;
            while j < data.len()
                && (j - (i + 3)) < MAX_PARAM_LEN
                && (data[j].is_ascii_digit() || data[j] == b';')
            {
                j += 1;
            }

            if j >= data.len() && (j - (i + 3)) < MAX_PARAM_LEN {
                self.pending.extend_from_slice(&data[i..]);
                break;
            }

            if j < data.len() {
                let params = &data[i + 3..j];
                let final_byte = data[j];
                match rewrite_win_keyboard_mode_seq(prefix, params, final_byte) {
                    SeqAction::Drop => {
                        i = j + 1;
                        continue;
                    }
                    SeqAction::Replace(replacement) => {
                        out.extend_from_slice(&replacement);
                        i = j + 1;
                        continue;
                    }
                    SeqAction::Keep => {}
                }
            }

            out.extend_from_slice(&data[i..i + 2]);
            i += 2;
        }

        out
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
enum SeqAction {
    Keep,
    Drop,
    Replace(Vec<u8>),
}

#[cfg_attr(not(windows), allow(dead_code))]
fn rewrite_win_keyboard_mode_seq(prefix: u8, params: &[u8], final_byte: u8) -> SeqAction {
    match (prefix, final_byte) {
        // Kitty keyboard protocol: CSI >...u / CSI =...u / CSI <...u / CSI ?u
        (b'>' | b'=' | b'<', b'u') => SeqAction::Drop,
        (b'?', b'u') if params.is_empty() => SeqAction::Drop,
        // XTerm modifyOtherKeys: CSI >4;...m or CSI >4m
        (b'>', b'm') if params == b"4" || params.starts_with(b"4;") => SeqAction::Drop,
        // Win32 input mode: CSI ?9001h/l (single or batched like CSI ?2004;9001h)
        (b'?', b'h' | b'l') => {
            if params == b"9001" {
                return SeqAction::Drop;
            }
            let parts: Vec<&[u8]> = params.split(|&b| b == b';').collect();
            if parts.iter().any(|&p| p == b"9001") {
                let kept: Vec<&[u8]> = parts.into_iter().filter(|&p| p != b"9001").collect();
                if kept.is_empty() {
                    return SeqAction::Drop;
                }
                let mut rebuilt = Vec::with_capacity(4 + params.len());
                rebuilt.extend_from_slice(b"\x1b[?");
                for (idx, p) in kept.iter().enumerate() {
                    if idx > 0 {
                        rebuilt.push(b';');
                    }
                    rebuilt.extend_from_slice(p);
                }
                rebuilt.push(final_byte);
                return SeqAction::Replace(rebuilt);
            }
            SeqAction::Keep
        }
        _ => SeqAction::Keep,
    }
}

/// Defense-in-depth input normalizer for Windows inbox ConPTY.
///
/// Translates enhanced keyboard sequences that Windows inbox `conhost.exe` silently drops:
/// - Kitty CSI-u: `ESC [ <codepoint>(:<shifted>)? (;<modifiers>(:<event>)?)? u`
/// - XTerm modifyOtherKeys: `ESC [ 27 ; <modifiers> ; <codepoint> ~`
/// - Win32 input mode: `ESC [ <vk> ; <sc> ; <uc> ; <kd> ; <cs> ; <rc> _`
///
/// Lone `0x1b` (`Esc`), standard VT sequences (`\x1b[A`, `\x1b[H`, `\x1b[Z`), C0 control
/// bytes (`\x03`), and UTF-8 text pass through untouched with zero buffering delay.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn normalize_win_conpty_input(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;

    while i < input.len() {
        if input[i] != 0x1b || i + 1 >= input.len() || input[i + 1] != b'[' {
            out.push(input[i]);
            i += 1;
            continue;
        }

        let start = i + 2;
        let mut j = start;
        while j < input.len()
            && (j - start) < 40
            && (input[j].is_ascii_digit() || input[j] == b';' || input[j] == b':')
        {
            j += 1;
        }

        if j < input.len() && j > start {
            let params = std::str::from_utf8(&input[start..j]).unwrap_or("");
            let final_byte = input[j];
            match final_byte {
                b'u' => {
                    if let Some(mapped) = translate_kitty_csi_u(params) {
                        out.extend_from_slice(&mapped);
                        i = j + 1;
                        continue;
                    }
                }
                b'~' => {
                    if let Some(mapped) = translate_modify_other_keys(params) {
                        out.extend_from_slice(&mapped);
                        i = j + 1;
                        continue;
                    }
                }
                b'_' => {
                    if let Some(mapped) = translate_win32_input_mode(params) {
                        out.extend_from_slice(&mapped);
                        i = j + 1;
                        continue;
                    }
                }
                _ => {}
            }
        }

        out.push(input[i]);
        i += 1;
    }

    out
}

#[cfg_attr(not(windows), allow(dead_code))]
fn translate_kitty_csi_u(params: &str) -> Option<Vec<u8>> {
    let mut parts = params.split(';');
    let key_part = parts.next()?;
    let mut key_sub = key_part.split(':');
    let codepoint: u32 = key_sub.next()?.parse().ok()?;
    let shifted_codepoint: Option<u32> = key_sub
        .next()
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse().ok());

    let mod_part = parts.next();
    let mut modifiers: u32 = 1;
    if let Some(mp) = mod_part {
        let mut sub = mp.split(':');
        if let Some(m_str) = sub.next() {
            if !m_str.is_empty() {
                modifiers = m_str.parse().ok()?;
            }
        }
        // Kitty event type: 1=press, 2=repeat, 3=release -> ignore key-release events
        if let Some(ev_str) = sub.next() {
            if ev_str == "3" {
                return Some(Vec::new());
            }
        }
    }

    // Kitty functional/modifier keys use Private Use Area 57344..=57454; never emit raw PUA UTF-8.
    if (57344..=57454).contains(&codepoint) {
        return Some(Vec::new());
    }

    let mods = modifiers.saturating_sub(1);
    let shift = (mods & 1) != 0;
    let ctrl = (mods & 4) != 0;
    let effective_cp = if shift && !ctrl {
        shifted_codepoint.unwrap_or(codepoint)
    } else {
        codepoint
    };

    Some(map_key_and_mods_to_vt(
        effective_cp,
        modifiers,
        shifted_codepoint.is_some(),
    ))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn translate_modify_other_keys(params: &str) -> Option<Vec<u8>> {
    let mut parts = params.split(';');
    if parts.next()? != "27" {
        return None;
    }
    let modifiers: u32 = parts.next()?.parse().ok()?;
    let codepoint: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(map_key_and_mods_to_vt(codepoint, modifiers, false))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn map_key_and_mods_to_vt(codepoint: u32, modifiers: u32, shift_already_applied: bool) -> Vec<u8> {
    let mods = modifiers.saturating_sub(1);
    let shift = (mods & 1) != 0;
    let alt = (mods & 2) != 0;
    let ctrl = (mods & 4) != 0;

    let mut out = Vec::with_capacity(4);
    if alt && codepoint != 27 {
        out.push(0x1b);
    }

    match codepoint {
        27 => {
            if alt {
                out.push(0x1b);
            }
            out.push(0x1b);
        }
        13 => {
            if shift && !alt {
                // Alt+Enter (`ESC CR`) inserts a newline without submitting in Ink/Claude/agy/PSReadLine
                // and passes cleanly through Windows inbox ConPTY.
                out.extend_from_slice(b"\x1b\r");
            } else {
                out.push(b'\r');
            }
        }
        9 => {
            if shift && !ctrl {
                out.extend_from_slice(b"\x1b[Z");
            } else {
                out.push(b'\t');
            }
        }
        127 => {
            if ctrl {
                out.push(0x08);
            } else {
                out.push(0x7f);
            }
        }
        c if ctrl => match c {
            97..=122 => out.push((c - 96) as u8),
            65..=90 => out.push((c - 64) as u8),
            64 | 32 => out.push(0x00),
            91..=95 => out.push((c - 64) as u8),
            _ => {
                if let Some(ch) = char::from_u32(c) {
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
            }
        },
        c => {
            if let Some(mut ch) = char::from_u32(c) {
                if shift && !shift_already_applied && ch.is_ascii_lowercase() {
                    ch = ch.to_ascii_uppercase();
                }
                let mut buf = [0u8; 4];
                out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            }
        }
    }

    out
}

#[cfg_attr(not(windows), allow(dead_code))]
fn translate_win32_input_mode(params: &str) -> Option<Vec<u8>> {
    let nums: Vec<u32> = params
        .split(';')
        .map(|p| if p.is_empty() { Ok(0) } else { p.parse::<u32>() })
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if nums.len() != 6 {
        return None;
    }

    let vk = nums[0];
    let uc = nums[2];
    let kd = nums[3];
    let cs = nums[4];
    let rc = nums[5].clamp(1, 32);

    // Ignore key-up events
    if kd == 0 {
        return Some(Vec::new());
    }

    let shift = (cs & 0x0010) != 0;
    let alt = (cs & 0x0003) != 0; // RIGHT_ALT (0x01) | LEFT_ALT (0x02)
    let ctrl = (cs & 0x000C) != 0; // RIGHT_CTRL (0x04) | LEFT_CTRL (0x08)

    let single: Vec<u8> = if uc > 0 {
        if uc == 9 && shift && !ctrl {
            b"\x1b[Z".to_vec()
        } else if uc == 13 && shift && !ctrl && !alt {
            b"\x1b\r".to_vec()
        } else if let Some(ch) = char::from_u32(uc) {
            let mut v = Vec::with_capacity(5);
            // Exclude Ctrl+Alt (Windows AltGr on international keyboards) from ESC prefixing
            if alt && !ctrl && uc < 128 && uc != 27 {
                v.push(0x1b);
            }
            let mut buf = [0u8; 4];
            v.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            v
        } else {
            Vec::new()
        }
    } else {
        match vk {
            27 => b"\x1b".to_vec(),
            38 => b"\x1b[A".to_vec(), // VK_UP
            40 => b"\x1b[B".to_vec(), // VK_DOWN
            39 => b"\x1b[C".to_vec(), // VK_RIGHT
            37 => b"\x1b[D".to_vec(), // VK_LEFT
            36 => b"\x1b[H".to_vec(), // VK_HOME
            35 => b"\x1b[F".to_vec(), // VK_END
            33 => b"\x1b[5~".to_vec(), // VK_PRIOR (PgUp)
            34 => b"\x1b[6~".to_vec(), // VK_NEXT (PgDn)
            45 => b"\x1b[2~".to_vec(), // VK_INSERT
            46 => b"\x1b[3~".to_vec(), // VK_DELETE
            9 if shift => b"\x1b[Z".to_vec(),
            9 => b"\t".to_vec(),
            112 => b"\x1bOP".to_vec(),   // F1
            113 => b"\x1bOQ".to_vec(),   // F2
            114 => b"\x1bOR".to_vec(),   // F3
            115 => b"\x1bOS".to_vec(),   // F4
            116 => b"\x1b[15~".to_vec(), // F5
            117 => b"\x1b[17~".to_vec(), // F6
            118 => b"\x1b[18~".to_vec(), // F7
            119 => b"\x1b[19~".to_vec(), // F8
            120 => b"\x1b[20~".to_vec(), // F9
            121 => b"\x1b[21~".to_vec(), // F10
            122 => b"\x1b[23~".to_vec(), // F11
            123 => b"\x1b[24~".to_vec(), // F12
            _ => Vec::new(),
        }
    };

    if single.is_empty() {
        return Some(Vec::new());
    }

    let mut out = Vec::with_capacity(single.len() * rc as usize);
    for _ in 0..rc {
        out.extend_from_slice(&single);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_console_guard_is_send() {
        fn assert_send<T: Send>() {}
        assert_send::<RawConsoleGuard>();
    }

    #[test]
    fn raw_input_mode_sets_vt_and_clears_cooked_flags() {
        let default_win_in = ENABLE_PROCESSED_INPUT
            | ENABLE_LINE_INPUT
            | ENABLE_ECHO_INPUT
            | ENABLE_WINDOW_INPUT
            | 0x0080; // ENABLE_EXTENDED_FLAGS
        let raw = compute_win_raw_input_mode(default_win_in);
        assert_ne!(raw & ENABLE_VIRTUAL_TERMINAL_INPUT, 0);
        assert_eq!(raw & ENABLE_LINE_INPUT, 0);
        assert_eq!(raw & ENABLE_ECHO_INPUT, 0);
        assert_eq!(raw & ENABLE_PROCESSED_INPUT, 0);
        assert_eq!(raw & ENABLE_WINDOW_INPUT, 0);
        assert_ne!(raw & 0x0080, 0);
    }

    #[test]
    fn raw_output_mode_enables_vt_processing() {
        let out = compute_win_raw_output_mode(0);
        assert_ne!(out & ENABLE_PROCESSED_OUTPUT, 0);
        assert_ne!(out & ENABLE_VIRTUAL_TERMINAL_PROCESSING, 0);
    }

    #[test]
    fn output_filter_strips_kitty_mok_and_win32_input_mode_only() {
        let mut f = WinOutputKeyboardFilter::new();
        let sample = b"\x1b[>5u\x1b[=5;1u\x1b[<u\x1b[?u\x1b[>4;2m\x1b[?9001h\x1b[?2026h\x1b[?2004h\x1b[32mhello\x1b[0m\x1b[?9001l";
        let got = f.filter(sample);
        assert_eq!(got, b"\x1b[?2026h\x1b[?2004h\x1b[32mhello\x1b[0m");
    }

    #[test]
    fn output_filter_strips_9001_inside_batched_decset_preserving_other_modes() {
        let mut f = WinOutputKeyboardFilter::new();
        assert_eq!(
            f.filter(b"\x1b[?1000;1002;1006;2004;9001h"),
            b"\x1b[?1000;1002;1006;2004h"
        );
        assert_eq!(f.filter(b"\x1b[?9001;2004l"), b"\x1b[?2004l");
    }

    #[test]
    fn output_filter_handles_split_chunks_cleanly() {
        let mut f = WinOutputKeyboardFilter::new();
        let mut out = f.filter(b"abc\x1b[>");
        out.extend_from_slice(&f.filter(b"5udef\x1b[?90"));
        out.extend_from_slice(&f.filter(b"01h\x1b[?2026$p"));
        assert_eq!(out, b"abcdef\x1b[?2026$p");
    }

    #[test]
    fn input_normalizer_preserves_lone_esc_arrows_and_utf8() {
        assert_eq!(normalize_win_conpty_input(b"\x1b"), b"\x1b");
        assert_eq!(normalize_win_conpty_input(b"\x03"), b"\x03");
        assert_eq!(normalize_win_conpty_input(b"\x1b[A\x1b[H\x1b[Z"), b"\x1b[A\x1b[H\x1b[Z");
        assert_eq!(normalize_win_conpty_input("中文".as_bytes()), "中文".as_bytes());
    }

    #[test]
    fn input_normalizer_translates_kitty_csi_u_and_drops_pua_modifiers() {
        assert_eq!(normalize_win_conpty_input(b"\x1b[27u"), b"\x1b");
        assert_eq!(normalize_win_conpty_input(b"\x1b[99;5u"), b"\x03");
        assert_eq!(normalize_win_conpty_input(b"\x1b[13;2u"), b"\x1b\r");
        assert_eq!(normalize_win_conpty_input(b"\x1b[9;2u"), b"\x1b[Z");
        assert_eq!(normalize_win_conpty_input(b"\x1b[93;5u"), b"\x1d");
        assert_eq!(normalize_win_conpty_input(b"\x1b[120;3u"), b"\x1bx");
        assert_eq!(normalize_win_conpty_input(b"\x1b[99;5:3u"), b"");
        // Shifted symbol (`1` + Shift -> `!`)
        assert_eq!(normalize_win_conpty_input(b"\x1b[49:33;2u"), b"!");
        // Standalone Shift/Ctrl PUA modifier keys must be dropped, never emitted as PUA UTF-8
        assert_eq!(normalize_win_conpty_input(b"\x1b[57441u\x1b[57442u"), b"");
    }

    #[test]
    fn input_normalizer_translates_modify_other_keys() {
        assert_eq!(normalize_win_conpty_input(b"\x1b[27;2;13~"), b"\x1b\r");
        assert_eq!(normalize_win_conpty_input(b"\x1b[27;5;99~"), b"\x03");
    }

    #[test]
    fn input_normalizer_translates_win32_input_mode_and_preserves_altgr() {
        assert_eq!(normalize_win_conpty_input(b"\x1b[27;1;27;1;0;1_"), b"\x1b");
        assert_eq!(normalize_win_conpty_input(b"\x1b[27;1;27;0;0;1_"), b"");
        assert_eq!(normalize_win_conpty_input(b"\x1b[67;46;3;1;8;1_"), b"\x03");
        assert_eq!(normalize_win_conpty_input(b"\x1b[38;72;0;1;0;1_"), b"\x1b[A");
        assert_eq!(normalize_win_conpty_input(b"\x1b[13;28;13;1;16;1_"), b"\x1b\r");
        // AltGr (RIGHT_ALT 0x01 + LEFT_CTRL 0x08 = 9) typing '@' (64) must not prepend ESC
        assert_eq!(normalize_win_conpty_input(b"\x1b[81;16;64;1;9;1_"), b"@");
    }
}
