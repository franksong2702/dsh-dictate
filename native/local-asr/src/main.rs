use std::{
    io::Cursor,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use axum::{
    extract::{DefaultBodyLimit, Multipart, State},
    http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};
use transcribe_cpp::{Model, RunOptions, Session};

const MODEL_ID: &str = "sensevoice";

struct AppState {
    session: Mutex<Session>,
    model_path: PathBuf,
}

#[derive(Serialize)]
struct Health<'a> {
    status: &'a str,
    models_loaded: [&'a str; 1],
    runtime: &'a str,
    runtime_version: &'a str,
    model_path: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    configure_console();
    if std::env::args().any(|arg| arg == "--version") {
        println!("dsh-dictate-asr {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let args = Args::parse()?;
    eprintln!("DSH Dictate Local ASR");
    eprintln!("Local-only service. Closing this window stops voice transcription.");
    eprintln!(
        "Loading SenseVoice model from {}",
        args.model_path.display()
    );
    let model = Model::load(&args.model_path)?;
    eprintln!(
        "SenseVoice loaded: architecture={} backend={} runtime={} ({})",
        model.arch(),
        model.backend(),
        transcribe_cpp::version(),
        transcribe_cpp::version_commit(),
    );
    let state = Arc::new(AppState {
        session: Mutex::new(model.session()?),
        model_path: args.model_path,
    });

    let origin = HeaderValue::from_str(&args.cors_origin)?;
    let cors = CorsLayer::new()
        .allow_origin(origin.clone())
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/audio/transcriptions", post(transcribe))
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(cors)
        .layer(middleware::from_fn_with_state(origin, require_origin))
        .with_state(state);
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), args.port);
    let listener = tokio::net::TcpListener::bind(address).await?;
    eprintln!("Native SenseVoice runtime listening on http://{address}");
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(windows)]
fn configure_console() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Console::SetConsoleTitleW;

    let title: Vec<u16> = std::ffi::OsStr::new("DSH Dictate Local ASR")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `title` is a valid, null-terminated UTF-16 buffer for the duration
    // of the call. A title failure is cosmetic and does not affect the service.
    unsafe {
        SetConsoleTitleW(title.as_ptr());
    }
}

#[cfg(not(windows))]
fn configure_console() {}

async fn require_origin(
    State(allowed_origin): State<HeaderValue>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    if !origin_allowed(request.headers(), &allowed_origin) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(request).await)
}

fn origin_allowed(headers: &HeaderMap, allowed_origin: &HeaderValue) -> bool {
    headers
        .get(header::ORIGIN)
        .is_none_or(|origin| origin == allowed_origin)
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Health<'static>> {
    Json(Health {
        status: "ok",
        models_loaded: [MODEL_ID],
        runtime: "transcribe.cpp",
        runtime_version: env!("CARGO_PKG_VERSION"),
        model_path: state.model_path.display().to_string(),
    })
}

async fn models() -> Json<serde_json::Value> {
    Json(json!({
        "object": "list",
        "data": [{ "id": MODEL_ID, "object": "model", "owned_by": "dsh-dictate" }]
    }))
}

async fn transcribe(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let mut audio = None;
    let mut language = None;
    while let Some(field) = multipart.next_field().await.map_err(bad_request)? {
        match field.name() {
            Some("file") => audio = Some(field.bytes().await.map_err(bad_request)?.to_vec()),
            Some("language") => language = Some(field.text().await.map_err(bad_request)?),
            _ => {}
        }
    }
    let bytes = audio.ok_or_else(|| error(StatusCode::BAD_REQUEST, "missing audio file"))?;
    let pcm = wav_samples(&bytes).map_err(|message| error(StatusCode::BAD_REQUEST, &message))?;
    let result = tokio::task::spawn_blocking(move || {
        let mut session = state
            .session
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        session
            .run(
                &pcm,
                &RunOptions {
                    language: language.filter(|value| value != "auto" && !value.is_empty()),
                    ..Default::default()
                },
            )
            .map_err(|cause| cause.to_string())
    })
    .await
    .map_err(|cause| error(StatusCode::INTERNAL_SERVER_ERROR, &cause.to_string()))?
    .map_err(|message| error(StatusCode::INTERNAL_SERVER_ERROR, &message))?;
    Ok(Json(json!({
        "text": result.text.trim(),
        "language": result.language,
        "model": MODEL_ID,
    })))
}

fn wav_samples(bytes: &[u8]) -> Result<Vec<f32>, String> {
    let mut reader =
        hound::WavReader::new(Cursor::new(bytes)).map_err(|cause| cause.to_string())?;
    let spec = reader.spec();
    if spec.channels != 1 || spec.sample_rate != 16_000 || spec.bits_per_sample != 16 {
        return Err("audio must be mono 16 kHz 16-bit PCM WAV".to_string());
    }
    reader
        .samples::<i16>()
        .map(|sample| {
            sample
                .map(|value| value as f32 / 32_768.0)
                .map_err(|cause| cause.to_string())
        })
        .collect()
}

fn bad_request(
    cause: axum::extract::multipart::MultipartError,
) -> (StatusCode, Json<serde_json::Value>) {
    error(StatusCode::BAD_REQUEST, &cause.to_string())
}

fn error(status: StatusCode, message: &str) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(json!({ "error": { "message": message } })))
}

struct Args {
    port: u16,
    cors_origin: String,
    model_path: PathBuf,
}

impl Args {
    fn parse() -> Result<Self, Box<dyn std::error::Error>> {
        let mut port = 39_081;
        let mut cors_origin = "http://127.0.0.1:3081".to_string();
        let mut model_path = None;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--port" => port = args.next().ok_or("--port requires a value")?.parse()?,
                "--cors-origin" => {
                    cors_origin = args.next().ok_or("--cors-origin requires a value")?
                }
                "--model-path" => {
                    model_path = Some(PathBuf::from(
                        args.next().ok_or("--model-path requires a value")?,
                    ));
                }
                // Accepted for compatibility with the host controller. The
                // service always binds IPv4 loopback and always uses CPU.
                "--host" | "--device" | "--model" => {
                    let _ = args.next().ok_or("option requires a value")?;
                }
                other => return Err(format!("unknown option: {other}").into()),
            }
        }
        let model_path = match model_path {
            Some(path) => path,
            None => default_model_path()?,
        };
        Ok(Self {
            port,
            cors_origin,
            model_path,
        })
    }
}

fn default_model_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let executable = std::env::current_exe()?;
    let root = executable
        .parent()
        .and_then(Path::parent)
        .ok_or("cannot resolve install root")?;
    Ok(root.join("models/SenseVoiceSmall-Q8_0.gguf"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_configured_origin_and_host_requests_without_an_origin() {
        let allowed = HeaderValue::from_static("http://127.0.0.1:3081");
        let mut headers = HeaderMap::new();
        assert!(origin_allowed(&headers, &allowed));
        headers.insert(header::ORIGIN, allowed.clone());
        assert!(origin_allowed(&headers, &allowed));
    }

    #[test]
    fn rejects_an_untrusted_browser_origin() {
        let allowed = HeaderValue::from_static("http://127.0.0.1:3081");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://untrusted.example"),
        );
        assert!(!origin_allowed(&headers, &allowed));
    }
}
