use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use zeroize::Zeroize;

use crate::encrypt::{decrypt_blob, encrypt_blob};
use crate::error::Result;

/// Encrypted local filesystem storage for wallet data.
///
/// Each collection is stored as a single encrypted file:
/// `{data_dir}/{name}.enc` containing `[nonce(12) | AES-256-GCM(JSON array) | tag(16)]`
pub struct Storage {
    data_dir: PathBuf,
    key: [u8; 32],
}

impl Storage {
    pub fn new(data_dir: PathBuf, key: [u8; 32]) -> Self {
        Self { data_dir, key }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Load a typed collection from encrypted storage.
    /// Returns an empty Vec if the collection file doesn't exist.
    pub fn load<T: DeserializeOwned>(&self, name: &str) -> Result<Vec<T>> {
        let path = self.data_dir.join(format!("{}.enc", name));
        if !path.exists() {
            return Ok(Vec::new());
        }
        let blob = std::fs::read(&path)?;
        let mut plaintext = decrypt_blob(&self.key, &blob)?;
        let items: Vec<T> = serde_json::from_slice(&plaintext)?;
        plaintext.zeroize();
        Ok(items)
    }

    /// Save a typed collection to encrypted storage.
    pub fn save<T: Serialize>(&self, name: &str, items: &[T]) -> Result<()> {
        std::fs::create_dir_all(&self.data_dir)?;
        let mut json = serde_json::to_vec(items)?;
        let blob = encrypt_blob(&self.key, &json)?;
        json.zeroize();
        std::fs::write(self.data_dir.join(format!("{}.enc", name)), &blob)?;
        Ok(())
    }

    /// Append a JSON value to a collection.
    pub fn append_value(&self, name: &str, item: serde_json::Value) -> Result<()> {
        let mut items: Vec<serde_json::Value> = self.load(name).unwrap_or_default();
        items.push(item);
        self.save(name, &items)
    }

    /// Check if a collection exists.
    pub fn collection_exists(&self, name: &str) -> bool {
        self.data_dir.join(format!("{}.enc", name)).exists()
    }

    /// List available collections.
    pub fn list_collections(&self) -> Result<Vec<String>> {
        if !self.data_dir.exists() {
            return Ok(Vec::new());
        }
        let mut collections = Vec::new();
        for entry in std::fs::read_dir(&self.data_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "enc") {
                if let Some(stem) = path.file_stem() {
                    collections.push(stem.to_string_lossy().into_owned());
                }
            }
        }
        Ok(collections)
    }
}

impl Drop for Storage {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use tempfile::TempDir;

    fn test_storage() -> (Storage, TempDir) {
        let dir = TempDir::new().unwrap();
        let key = [42u8; 32];
        let storage = Storage::new(dir.path().join("data"), key);
        (storage, dir)
    }

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
    struct TestItem {
        name: String,
        value: i32,
    }

    #[test]
    fn roundtrip_collection() {
        let (storage, _dir) = test_storage();
        let items = vec![
            TestItem {
                name: "a".into(),
                value: 1,
            },
            TestItem {
                name: "b".into(),
                value: 2,
            },
        ];
        storage.save("test", &items).unwrap();
        let loaded: Vec<TestItem> = storage.load("test").unwrap();
        assert_eq!(loaded, items);
    }

    #[test]
    fn load_nonexistent_returns_empty() {
        let (storage, _dir) = test_storage();
        let items: Vec<TestItem> = storage.load("nope").unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn append_value_works() {
        let (storage, _dir) = test_storage();
        let item1 = serde_json::json!({"name": "a", "value": 1});
        let item2 = serde_json::json!({"name": "b", "value": 2});
        storage.append_value("test", item1).unwrap();
        storage.append_value("test", item2).unwrap();
        let loaded: Vec<TestItem> = storage.load("test").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].name, "a");
        assert_eq!(loaded[1].name, "b");
    }

    #[test]
    fn list_collections_works() {
        let (storage, _dir) = test_storage();
        storage.save("alpha", &vec![1, 2, 3]).unwrap();
        storage.save("beta", &vec![4, 5]).unwrap();
        let mut cols = storage.list_collections().unwrap();
        cols.sort();
        assert_eq!(cols, vec!["alpha", "beta"]);
    }
}
