use once_cell::sync::Lazy;
use regex::Regex;

static MOBILE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?x)(?P<prefix>(?:\+?86[-\s]?)?)1[3-9]\d{9}").unwrap());
static LANDLINE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?x)(^|[^\d])((?:0\d{2,3}[-\s]?)?\d{7,8})([^\d]|$)").unwrap());
static ADDRESS_LABEL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(地址|住址|收件地址|寄件地址)[:：][^，。,；;】\]]+").unwrap());

pub fn sanitize_route_remark(input: &str) -> String {
    let text = input.replace("电联快递员", "联系快递员");
    let text = MOBILE_RE.replace_all(&text, "[已脱敏]");
    let text = LANDLINE_RE.replace_all(&text, "$1[已脱敏]$3");
    ADDRESS_LABEL_RE
        .replace_all(&text, "$1：[已脱敏]")
        .to_string()
}

pub fn sanitize_accept_address(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    for municipality in ["北京市", "上海市", "天津市", "重庆市"] {
        if trimmed.starts_with(municipality) {
            return municipality.to_string();
        }
    }

    if let Some(city_idx) = trimmed.find('市') {
        return trimmed[..city_idx + '市'.len_utf8()].to_string();
    }

    if let Some(county_idx) = trimmed.find('县') {
        return trimmed[..county_idx + '县'.len_utf8()].to_string();
    }

    if let Some(district_idx) = trimmed.find('区') {
        return trimmed[..district_idx + '区'.len_utf8()].to_string();
    }

    trimmed.chars().take(12).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_courier_phone_but_keeps_meaning() {
        let text = "如有疑问请电联快递员【钱凯，电话：13355606980】";

        assert_eq!(
            sanitize_route_remark(text),
            "如有疑问请联系快递员【钱凯，电话：[已脱敏]】"
        );
    }

    #[test]
    fn keeps_city_level_address() {
        assert_eq!(
            sanitize_accept_address("安徽省合肥市蜀山区潜山路1号"),
            "安徽省合肥市"
        );
        assert_eq!(sanitize_accept_address("北京市朝阳区某街道1号"), "北京市");
    }
}
