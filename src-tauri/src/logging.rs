use chrono::Utc;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Arc,
};

const MAX_LOG_BYTES: u64 = 512 * 1024;

#[derive(Clone)]
pub struct Logger {
    path: Arc<PathBuf>,
}

impl Logger {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path: Arc::new(path),
        }
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub fn line(&self, text: impl AsRef<str>) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::metadata(&*self.path).is_ok_and(|metadata| metadata.len() > MAX_LOG_BYTES) {
            let _ = fs::rename(&*self.path, self.path.with_extension("log.old"));
        }
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&*self.path)
        {
            let _ = writeln!(file, "[{}] {}", Utc::now().to_rfc3339(), text.as_ref());
        }
    }
}
