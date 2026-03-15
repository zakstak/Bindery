use std::io::Cursor;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use image::{
    codecs::jpeg::JpegEncoder,
    imageops::FilterType,
    DynamicImage, ImageFormat, ImageReader,
};
use napi_derive::napi;

#[napi(object)]
pub struct ResizeOptions {
    pub data: String,
    pub mime_type: String,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub max_bytes: Option<u32>,
    pub jpeg_quality: Option<u32>,
}

#[napi(object)]
pub struct ResizeResult {
    pub data: String,
    pub mime_type: String,
    pub original_width: u32,
    pub original_height: u32,
    pub width: u32,
    pub height: u32,
    pub was_resized: bool,
}

#[napi(object)]
pub struct ConvertResult {
    pub data: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

fn decode_image(data: &str) -> napi::Result<(DynamicImage, Vec<u8>)> {
    let bytes = BASE64
        .decode(data)
        .map_err(|e| napi::Error::from_reason(format!("failed to decode base64: {e}")))?;
    let reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| napi::Error::from_reason(format!("failed to guess image format: {e}")))?;
    let img = reader
        .decode()
        .map_err(|e| napi::Error::from_reason(format!("failed to decode image: {e}")))?;
    Ok((img, bytes))
}

fn encode_png(img: &DynamicImage) -> napi::Result<Vec<u8>> {
    let mut buf = Vec::new();
    img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
        .map_err(|e| napi::Error::from_reason(format!("failed to encode PNG: {e}")))?;
    Ok(buf)
}

fn encode_jpeg(img: &DynamicImage, quality: u8) -> napi::Result<Vec<u8>> {
    let mut buf = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut buf, quality);
    img.write_with_encoder(encoder)
        .map_err(|e| napi::Error::from_reason(format!("failed to encode JPEG: {e}")))?;
    Ok(buf)
}

fn pick_smaller(png: Vec<u8>, jpeg: Vec<u8>) -> (Vec<u8>, &'static str) {
    if png.len() <= jpeg.len() {
        (png, "image/png")
    } else {
        (jpeg, "image/jpeg")
    }
}

fn try_both(
    img: &DynamicImage,
    width: u32,
    height: u32,
    quality: u8,
) -> napi::Result<(Vec<u8>, &'static str)> {
    let resized = img.resize_exact(width, height, FilterType::Lanczos3);
    let png = encode_png(&resized)?;
    let jpeg = encode_jpeg(&resized, quality)?;
    Ok(pick_smaller(png, jpeg))
}

#[napi]
pub fn resize_image(options: ResizeOptions) -> napi::Result<ResizeResult> {
    let max_width = options.max_width.unwrap_or(2000);
    let max_height = options.max_height.unwrap_or(2000);
    let max_bytes = options.max_bytes.unwrap_or(4_718_592) as usize;
    let jpeg_quality = options.jpeg_quality.unwrap_or(80) as u8;

    let (img, original_bytes) = decode_image(&options.data)?;
    let original_width = img.width();
    let original_height = img.height();

    // Already within all limits
    if original_width <= max_width
        && original_height <= max_height
        && original_bytes.len() <= max_bytes
    {
        return Ok(ResizeResult {
            data: options.data,
            mime_type: options.mime_type,
            original_width,
            original_height,
            width: original_width,
            height: original_height,
            was_resized: false,
        });
    }

    // Calculate target dimensions
    let mut target_width = original_width;
    let mut target_height = original_height;

    if target_width > max_width {
        target_height = (target_height as u64 * max_width as u64 / target_width as u64) as u32;
        target_width = max_width;
    }
    if target_height > max_height {
        target_width = (target_width as u64 * max_height as u64 / target_height as u64) as u32;
        target_height = max_height;
    }

    // First attempt at target dimensions
    let (buf, mime) = try_both(&img, target_width, target_height, jpeg_quality)?;
    if buf.len() <= max_bytes {
        return Ok(ResizeResult {
            data: BASE64.encode(&buf),
            mime_type: mime.to_string(),
            original_width,
            original_height,
            width: target_width,
            height: target_height,
            was_resized: true,
        });
    }

    // Try decreasing quality
    let quality_steps: &[u8] = &[85, 70, 55, 40];
    for &q in quality_steps {
        let (buf, mime) = try_both(&img, target_width, target_height, q)?;
        if buf.len() <= max_bytes {
            return Ok(ResizeResult {
                data: BASE64.encode(&buf),
                mime_type: mime.to_string(),
                original_width,
                original_height,
                width: target_width,
                height: target_height,
                was_resized: true,
            });
        }
    }

    // Reduce dimensions progressively
    let scale_steps: &[f64] = &[0.75, 0.5, 0.35, 0.25];
    let mut final_width = target_width;
    let mut final_height = target_height;
    let mut best_buf = Vec::new();
    let mut best_mime = "image/jpeg";

    for &scale in scale_steps {
        final_width = (target_width as f64 * scale).round() as u32;
        final_height = (target_height as f64 * scale).round() as u32;

        if final_width < 100 || final_height < 100 {
            break;
        }

        for &q in quality_steps {
            let (buf, mime) = try_both(&img, final_width, final_height, q)?;
            if buf.len() <= max_bytes {
                return Ok(ResizeResult {
                    data: BASE64.encode(&buf),
                    mime_type: mime.to_string(),
                    original_width,
                    original_height,
                    width: final_width,
                    height: final_height,
                    was_resized: true,
                });
            }
            best_buf = buf;
            best_mime = mime;
        }
    }

    // Last resort
    Ok(ResizeResult {
        data: BASE64.encode(&best_buf),
        mime_type: best_mime.to_string(),
        original_width,
        original_height,
        width: final_width,
        height: final_height,
        was_resized: true,
    })
}

#[napi]
pub fn convert_to_png(data: String) -> napi::Result<ConvertResult> {
    let (img, _) = decode_image(&data)?;
    let buf = encode_png(&img)?;
    Ok(ConvertResult {
        data: BASE64.encode(&buf),
        mime_type: "image/png".to_string(),
        width: img.width(),
        height: img.height(),
    })
}
