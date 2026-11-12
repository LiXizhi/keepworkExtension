//! Optional inline-image turn contract shared with the Node runtime.
//! Image bytes go only to the native CLI; daemon history keeps placeholders.
use super::discovery::Protocol;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

const MAX_BYTES: usize = 4 * 1024 * 1024;

pub(super) struct Image {
    url: String,
    mime: String,
    data: String,
}

pub(super) fn parse(value: Option<&Value>) -> Result<Vec<Image>, String> {
    let Some(value) = value else {
        return Ok(vec![]);
    };
    let values = value
        .as_array()
        .filter(|values| !values.is_empty() && values.len() <= 4)
        .ok_or("Attach 1 to 4 images")?;
    let mut bytes = 0;
    values
        .iter()
        .map(|value| {
            let url = value
                .as_str()
                .filter(|url| url.len() <= 5_600_000)
                .ok_or("Expected a base64 raster image (maximum 4 MiB per turn)")?;
            let (mime, data) = url
                .strip_prefix("data:")
                .and_then(|value| value.split_once(";base64,"))
                .filter(|(mime, _)| {
                    matches!(
                        *mime,
                        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
                    )
                })
                .ok_or("Expected a base64 raster image")?;
            let decoded = STANDARD
                .decode(data)
                .map_err(|_| "Expected a base64 raster image")?;
            if decoded.is_empty() {
                return Err("Expected a base64 raster image".into());
            }
            bytes += decoded.len();
            if bytes > MAX_BYTES {
                return Err("Image limit is 4 MiB per turn".into());
            }
            Ok(Image {
                url: url.into(),
                mime: mime.into(),
                data: data.into(),
            })
        })
        .collect()
}

pub(super) fn content(text: &str, images: &[Image], protocol: Protocol) -> Value {
    let mut parts = vec![json!({"type":"text", "text":text})];
    parts.extend(images.iter().map(|image| match protocol {
        Protocol::Codex => json!({"type":"image", "url":image.url}),
        Protocol::Claude => json!({"type":"image", "source":{"type":"base64", "media_type":image.mime, "data":image.data}}),
        _ => json!({"type":"image", "mimeType":image.mime, "data":image.data}),
    }));
    json!(parts)
}

pub(super) fn is_inline(value: &Value) -> bool {
    value["type"] == "image"
        && (value.get("data").is_some()
            || value["source"].get("data").is_some()
            || value["url"]
                .as_str()
                .is_some_and(|url| url.starts_with("data:")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_images_are_bounded_and_never_fetch_paths_or_urls() {
        assert!(parse(None).unwrap().is_empty());
        for value in [
            json!(null),
            json!([]),
            json!(["file:///private.png"]),
            json!(["https://example.com/a.png"]),
            json!(["data:image/svg+xml;base64,YQ=="]),
            json!(["data:image/png;base64,"]),
            json!(["data:image/png;base64,YQ="]),
            json!(["data:image/png;base64,Y!=="]),
            json!(["data:image/png;base64,YR=="]),
            json!(vec!["data:image/png;base64,YQ=="; 5]),
        ] {
            assert!(parse(Some(&value)).is_err(), "{value}");
        }
        let exact = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(vec![0; MAX_BYTES])
        );
        assert!(parse(Some(&json!([exact]))).is_ok());
        assert!(parse(Some(&json!([exact, "data:image/png;base64,YQ=="]))).is_err());
    }

    #[test]
    fn native_content_preserves_bytes_and_history_redacts_them() {
        let url = "data:image/png;base64,YQ==";
        let images = parse(Some(&json!([url]))).unwrap();
        for (protocol, expected) in [
            (Protocol::Codex, json!({"type":"image", "url":url})),
            (
                Protocol::Claude,
                json!({"type":"image", "source":{"type":"base64", "media_type":"image/png", "data":"YQ=="}}),
            ),
            (
                Protocol::Acp,
                json!({"type":"image", "mimeType":"image/png", "data":"YQ=="}),
            ),
        ] {
            let content = content("Describe", &images, protocol);
            assert_eq!(content[1], expected);
            assert_eq!(
                super::super::scrub(&content, 0, &mut 10_000),
                json!([{"type":"text", "text":"Describe"}, {"type":"image"}])
            );
        }
    }
}
