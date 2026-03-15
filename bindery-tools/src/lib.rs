use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::WalkBuilder;
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

// ── ripgrep search ─────────────────────────────────────────────────

#[napi(object)]
pub struct GrepOptions {
    pub pattern: String,
    pub path: String,
    pub glob: Option<String>,
    pub ignore_case: Option<bool>,
    pub literal: Option<bool>,
    pub limit: Option<u32>,
}

#[napi(object)]
pub struct GrepMatch {
    pub file_path: String,
    pub line_number: u32,
    pub line_text: String,
}

/// Collect matches from a single file into a shared vec, respecting a limit.
struct MatchSink {
    file_path: String,
    matches: Vec<GrepMatch>,
    limit: usize,
    limit_reached: Arc<AtomicBool>,
}

impl Sink for MatchSink {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        mat: &SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        if self.limit_reached.load(Ordering::Relaxed) {
            return Ok(false);
        }

        let line_text = String::from_utf8_lossy(mat.bytes()).trim_end().to_string();
        self.matches.push(GrepMatch {
            file_path: self.file_path.clone(),
            line_number: mat.line_number().unwrap_or(0) as u32,
            line_text,
        });

        if self.matches.len() >= self.limit {
            self.limit_reached.store(true, Ordering::Relaxed);
            return Ok(false);
        }

        Ok(true)
    }
}

#[napi]
pub fn rg_search(options: GrepOptions) -> napi::Result<Vec<GrepMatch>> {
    let limit = options.limit.unwrap_or(100) as usize;
    let limit_reached = Arc::new(AtomicBool::new(false));

    // Build regex matcher
    let mut builder = RegexMatcherBuilder::new();
    if options.ignore_case.unwrap_or(false) {
        builder.case_insensitive(true);
    }

    let effective_pattern = if options.literal.unwrap_or(false) {
        regex::escape(&options.pattern)
    } else {
        options.pattern.clone()
    };

    let matcher = builder
        .build(&effective_pattern)
        .map_err(|e| napi::Error::from_reason(format!("invalid pattern: {e}")))?;

    let path = Path::new(&options.path);
    if !path.exists() {
        return Err(napi::Error::from_reason(format!(
            "Path not found: {}",
            options.path
        )));
    }

    let mut all_matches: Vec<GrepMatch> = Vec::new();

    let is_dir = path.is_dir();

    if is_dir {
        // Directory search: walk with .gitignore awareness
        let mut walk_builder = WalkBuilder::new(path);
        walk_builder
            .hidden(false) // include hidden files
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true);

        // Apply glob filter
        if let Some(ref glob_pattern) = options.glob {
            // Use an override to filter by glob
            let mut overrides = ignore::overrides::OverrideBuilder::new(path);
            overrides
                .add(glob_pattern)
                .map_err(|e| napi::Error::from_reason(format!("invalid glob: {e}")))?;
            let built = overrides
                .build()
                .map_err(|e| napi::Error::from_reason(format!("invalid glob: {e}")))?;
            walk_builder.overrides(built);
        }

        let mut searcher = SearcherBuilder::new()
            .line_number(true)
            .build();

        for entry in walk_builder.build() {
            if limit_reached.load(Ordering::Relaxed) {
                break;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            // Skip directories
            if entry.file_type().map_or(true, |ft| ft.is_dir()) {
                continue;
            }

            let file_path = entry.path().to_string_lossy().to_string();
            let remaining = limit.saturating_sub(all_matches.len());
            if remaining == 0 {
                break;
            }

            let mut sink = MatchSink {
                file_path,
                matches: Vec::new(),
                limit: remaining,
                limit_reached: Arc::clone(&limit_reached),
            };

            // Ignore errors from individual files (binary, unreadable, etc.)
            let _ = searcher.search_path(&matcher, entry.path(), &mut sink);
            all_matches.extend(sink.matches);
        }
    } else {
        // Single file search
        let mut searcher = SearcherBuilder::new()
            .line_number(true)
            .build();

        let file_path = path.to_string_lossy().to_string();
        let mut sink = MatchSink {
            file_path,
            matches: Vec::new(),
            limit,
            limit_reached: Arc::clone(&limit_reached),
        };

        searcher
            .search_path(&matcher, path, &mut sink)
            .map_err(|e| napi::Error::from_reason(format!("search failed: {e}")))?;

        all_matches = sink.matches;
    }

    Ok(all_matches)
}

