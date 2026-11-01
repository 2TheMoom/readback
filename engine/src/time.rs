//! Minimal RFC 3339 / ISO 8601 parsing for the UTC timestamps 1Click and NEAR Intents use
//! (`2026-10-23T23:12:50.322Z`, `2026-12-31T23:59:59Z`). No time zone offsets other than `Z`.

/// Milliseconds since the Unix epoch, or `None` if the string is not a UTC timestamp we accept.
pub fn parse_utc_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || *b.last()? != b'Z' {
        return None;
    }
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = s.get(from..from + len)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (h, mi, se) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    // optional fraction: .f to .fffffffff, then Z
    let rest = &s[19..s.len() - 1];
    let ms = if rest.is_empty() {
        0
    } else {
        let frac = rest.strip_prefix('.')?;
        if frac.is_empty() || frac.len() > 9 || !frac.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let padded = format!("{:0<3}", &frac[..frac.len().min(3)]);
        padded.parse::<i64>().ok()?
    };
    Some(days_from_civil(y, mo, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + se * 1000 + ms)
}

/// Howard Hinnant's days-from-civil: days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::parse_utc_ms;

    #[test]
    fn known_instants() {
        assert_eq!(parse_utc_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_utc_ms("2026-11-01T00:00:00Z"), Some(1_793_491_200_000));
        assert_eq!(parse_utc_ms("2026-10-23T23:12:50.322Z"), Some(1_792_797_170_322));
        assert_eq!(parse_utc_ms("2024-02-29T12:00:00.5Z"), Some(1_709_208_000_500));
    }

    #[test]
    fn rejects_other_shapes() {
        for bad in ["", "2026-11-01", "2026-11-01T00:00:00+01:00", "2026-13-01T00:00:00Z", "2026-11-01T00:00:00.Z", "2026-1x-01T00:00:00Z", "２０２６-11-01T00:00:00Z"] {
            assert_eq!(parse_utc_ms(bad), None, "{bad}");
        }
    }
}
