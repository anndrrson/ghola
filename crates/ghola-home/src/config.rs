use std::path::PathBuf;

#[derive(Clone)]
pub struct HomeConfig {
    pub bind_addr: String,
    pub db_path: PathBuf,
    pub pin: String,
    pub server_name: String,
}

impl HomeConfig {
    pub fn from_env() -> Self {
        let bind_addr = std::env::var("GHOLA_HOME_BIND").unwrap_or_else(|_| "0.0.0.0:3000".into());

        let db_path = std::env::var("GHOLA_HOME_DB")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let mut p = dirs::home_dir().expect("no home directory");
                p.push(".ghola");
                p.push("ghola.db");
                p
            });

        let pin = std::env::var("GHOLA_HOME_PIN").unwrap_or_else(|_| {
            use rand::Rng;
            let n: u16 = rand::thread_rng().gen_range(1000..10000);
            n.to_string()
        });

        let server_name = std::env::var("GHOLA_HOME_NAME").unwrap_or_else(|_| "Ghola Home".into());

        Self {
            bind_addr,
            db_path,
            pin,
            server_name,
        }
    }
}
