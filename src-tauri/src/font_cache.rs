//! 字体磁盘缓存（Rust 侧下载 + IPC 字节直供）
//!
//! 页面内的字体网络路径（<link> preload / @font-face 远程 URL / JS fetch /
//! 自定义协议子资源）在 WebKit 里偶发被网络栈整体掐死——2026-10-25 双重
//! 实证：fetch 秒拒（TypeError: Load failed 且 ResourceTiming 无条目、系统
//! 代理零流量）；atreader://fonts/ 协议 URL 亦同（@font-face 已注册而
//! document.fonts.check 恒 false）。唯一可靠通道是绕开页面网络：Rust 下载
//! 落盘（磁盘永久缓存，下载一次管终身，跨会话有效），命令把文件字节经
//! IPC 以 base64 直交页面，插件用 FontFace(ArrayBuffer) 程序化注册——
//! 零网络请求，任何拦截层都摸不到。
//!
//! 安全边界：下载 URL 白名单硬编码为本项目 CDN 字体目录（方正商用字体，
//! 授权链仅覆盖掌阅站点使用）；缓存目录内文件名 = URL sha256 哈希，读取
//! 仅发生在 ensure_font_cache 白名单校验之后。

use std::io::Read;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};

/// 字体下载仅允许本项目的 CDN 字体路径（授权边界：方正商用字体仅供掌阅站点使用）
const ALLOWED_FONT_PREFIX: &str = "https://cdn.dengcb.net/fonts/";
/// 单字体文件大小上限（防异常响应撑爆磁盘）
const MAX_FONT_BYTES: usize = 12 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontCacheInfo {
    /// 字体文件 base64：经 IPC 直交页面，FontFace(ArrayBuffer) 注册用
    pub data_base64: String,
}

/// URL → 缓存文件名（sha256 前 8 字节十六进制）。仅放行本项目 CDN 字体目录
/// 下的 .ttf，其余一律拒绝。
pub fn cache_file_name(url: &str) -> Option<String> {
    if !url.starts_with(ALLOWED_FONT_PREFIX) || !url.ends_with(".ttf") {
        return None;
    }
    let tail = &url[ALLOWED_FONT_PREFIX.len()..url.len() - 4];
    let name_ok = !tail.is_empty()
        && tail
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
    if !name_ok {
        return None;
    }
    let digest = Sha256::digest(url.as_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{:02x}", b)).collect();
    Some(format!("font-{}.ttf", hex))
}

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("fonts"))
}

/// 确保字体已缓存到磁盘并返回文件字节（base64）。缓存命中零网络；未命中
/// 走 Rust 直连下载（不经过 WebKit，系统代码无法拦截）。
#[tauri::command]
pub async fn ensure_font_cache<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<FontCacheInfo, String> {
    let name = cache_file_name(&url).ok_or_else(|| "font url not allowed".to_string())?;
    let dir = cache_dir(&app)?;
    let path = dir.join(&name);
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 0 {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            return Ok(FontCacheInfo {
                data_base64: BASE64_STANDARD.encode(&data),
            });
        }
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || download_font(&url))
        .await
        .map_err(|e| e.to_string())??;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{}.part", name));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(FontCacheInfo {
        data_base64: BASE64_STANDARD.encode(&bytes),
    })
}

fn download_font(url: &str) -> Result<Vec<u8>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(120))
        .build();
    let response = agent.get(url).call().map_err(|e| e.to_string())?;
    let mut reader = response.into_reader().take((MAX_FONT_BYTES + 1) as u64);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_FONT_BYTES {
        return Err("font too large".to_string());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_file_name_allowlist() {
        let ok = "https://cdn.dengcb.net/fonts/FZYouH_506L_pua.ttf";
        let name = cache_file_name(ok).expect("allowed url should map");
        assert!(name.starts_with("font-"));
        assert!(name.ends_with(".ttf"));
        assert_eq!(cache_file_name(ok), Some(name.clone()));
        // 同前缀但非 ttf
        assert_eq!(cache_file_name("https://cdn.dengcb.net/fonts/a.woff2"), None);
        // 前缀外的域名
        assert_eq!(cache_file_name("https://evil.example.com/fonts/a.ttf"), None);
        // 前缀内但路径带斜杠（子目录穿越面）
        assert_eq!(
            cache_file_name("https://cdn.dengcb.net/fonts/../a.ttf"),
            None
        );
    }
}
