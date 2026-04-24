use std::collections::HashSet;
use std::fmt::Write;

use said_types::*;

use crate::error::Result;
use crate::Wallet;

const STOPWORDS: &[&str] = &[
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should", "may", "might", "shall", "can", "and",
    "or", "but", "if", "in", "on", "at", "to", "for", "of", "it", "its", "this", "that", "with",
    "from", "by", "as", "not", "no",
];

/// Tokenize text into lowercase keywords, splitting on whitespace and punctuation,
/// then filter out stopwords.
fn tokenize_and_filter(text: &str) -> Vec<String> {
    let stopwords: HashSet<&str> = STOPWORDS.iter().copied().collect();
    text.to_lowercase()
        .split(|c: char| c.is_whitespace() || c.is_ascii_punctuation())
        .filter(|w| !w.is_empty() && !stopwords.contains(w))
        .map(String::from)
        .collect()
}

/// Score how relevant `text` is to the given topic keywords.
/// Returns matching_keywords / total_topic_keywords (0.0 if no topic keywords).
fn score_text(topic_keywords: &[String], text: &str) -> f64 {
    if topic_keywords.is_empty() {
        return 0.0;
    }
    let text_lower = text.to_lowercase();
    let matching = topic_keywords
        .iter()
        .filter(|kw| text_lower.contains(kw.as_str()))
        .count();
    matching as f64 / topic_keywords.len() as f64
}

impl Wallet {
    /// Load the system prompt from storage. Prefers one named "default",
    /// otherwise returns the first available prompt.
    fn load_system_prompt(&self) -> Result<Option<SystemPrompt>> {
        let prompts: Vec<SystemPrompt> = self.storage().load("prompts")?;
        if prompts.is_empty() {
            return Ok(None);
        }
        // Prefer one named "default"
        if let Some(default) = prompts.iter().find(|p| p.name == "default") {
            return Ok(Some(default.clone()));
        }
        Ok(Some(prompts[0].clone()))
    }

    /// Build a full portable context block from all wallet data.
    pub fn get_full_context(&self) -> Result<String> {
        let prompt = self.load_system_prompt()?;
        let memories: Vec<Memory> = self.storage().load("memories")?;
        let preferences: Vec<Preference> = self.storage().load("preferences")?;
        let knowledge: Vec<KnowledgeDoc> = self.storage().load("knowledge")?;

        let mut out = String::from("# SAID Identity Context\n");

        // System Prompt
        out.push_str("\n## System Prompt\n");
        match &prompt {
            Some(p) => {
                write!(out, "{}\n", p.content).unwrap();
            }
            None => {
                out.push_str("(none)\n");
            }
        }

        // Memories
        out.push_str("\n## Memories\n");
        if memories.is_empty() {
            out.push_str("(none)\n");
        } else {
            for m in &memories {
                write!(out, "- {}\n", m.content).unwrap();
            }
        }

        // Preferences
        out.push_str("\n## Preferences\n");
        if preferences.is_empty() {
            out.push_str("(none)\n");
        } else {
            for p in &preferences {
                write!(out, "- {}: {}\n", p.key, p.value).unwrap();
            }
        }

        // Knowledge
        out.push_str("\n## Knowledge\n");
        if knowledge.is_empty() {
            out.push_str("(none)\n");
        } else {
            for k in &knowledge {
                write!(out, "- {}: {}\n", k.title, k.content).unwrap();
            }
        }

        Ok(out)
    }

    /// Build a context block containing only items relevant to the given topic,
    /// scored by keyword overlap. Returns the top `limit` items across all categories.
    pub fn get_relevant_context(&self, topic: &str, limit: usize) -> Result<String> {
        let topic_keywords = tokenize_and_filter(topic);

        let prompt = self.load_system_prompt()?;
        let memories: Vec<Memory> = self.storage().load("memories")?;
        let preferences: Vec<Preference> = self.storage().load("preferences")?;
        let knowledge: Vec<KnowledgeDoc> = self.storage().load("knowledge")?;

        // Score and collect each category
        let prompt_score = prompt
            .as_ref()
            .map(|p| score_text(&topic_keywords, &p.content))
            .unwrap_or(0.0);

        let mut scored_memories: Vec<(f64, &Memory)> = memories
            .iter()
            .map(|m| {
                let combined = format!("{} {}", m.content, m.tags.join(" "));
                (score_text(&topic_keywords, &combined), m)
            })
            .filter(|(s, _)| *s > 0.0)
            .collect();
        scored_memories.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());

        let mut scored_preferences: Vec<(f64, &Preference)> = preferences
            .iter()
            .map(|p| {
                let combined = format!("{} {}", p.key, p.value);
                (score_text(&topic_keywords, &combined), p)
            })
            .filter(|(s, _)| *s > 0.0)
            .collect();
        scored_preferences.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());

        let mut scored_knowledge: Vec<(f64, &KnowledgeDoc)> = knowledge
            .iter()
            .map(|k| {
                let combined = format!("{} {} {}", k.title, k.content, k.tags.join(" "));
                (score_text(&topic_keywords, &combined), k)
            })
            .filter(|(s, _)| *s > 0.0)
            .collect();
        scored_knowledge.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());

        // Truncate each category to `limit`
        scored_memories.truncate(limit);
        scored_preferences.truncate(limit);
        scored_knowledge.truncate(limit);

        let mut out = String::from("# SAID Relevant Context\n");

        // System Prompt (include if relevant)
        out.push_str("\n## System Prompt\n");
        if prompt_score > 0.0 {
            if let Some(p) = &prompt {
                write!(out, "{}\n", p.content).unwrap();
            }
        } else {
            out.push_str("(not relevant)\n");
        }

        // Relevant Memories
        out.push_str("\n## Relevant Memories\n");
        if scored_memories.is_empty() {
            out.push_str("(none)\n");
        } else {
            for (score, m) in &scored_memories {
                write!(out, "- {} (score: {:.2})\n", m.content, score).unwrap();
            }
        }

        // Relevant Preferences
        out.push_str("\n## Relevant Preferences\n");
        if scored_preferences.is_empty() {
            out.push_str("(none)\n");
        } else {
            for (score, p) in &scored_preferences {
                write!(out, "- {}: {} (score: {:.2})\n", p.key, p.value, score).unwrap();
            }
        }

        // Relevant Knowledge
        out.push_str("\n## Relevant Knowledge\n");
        if scored_knowledge.is_empty() {
            out.push_str("(none)\n");
        } else {
            for (score, k) in &scored_knowledge {
                write!(out, "- {}: {} (score: {:.2})\n", k.title, k.content, score).unwrap();
            }
        }

        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn tokenize_removes_stopwords() {
        let tokens = tokenize_and_filter("The quick brown fox is on the mat");
        assert!(tokens.contains(&"quick".to_string()));
        assert!(tokens.contains(&"brown".to_string()));
        assert!(tokens.contains(&"fox".to_string()));
        assert!(tokens.contains(&"mat".to_string()));
        // Stopwords removed
        assert!(!tokens.contains(&"the".to_string()));
        assert!(!tokens.contains(&"is".to_string()));
        assert!(!tokens.contains(&"on".to_string()));
    }

    #[test]
    fn tokenize_splits_punctuation() {
        let tokens = tokenize_and_filter("hello,world! foo-bar");
        assert!(tokens.contains(&"hello".to_string()));
        assert!(tokens.contains(&"world".to_string()));
        assert!(tokens.contains(&"foo".to_string()));
        assert!(tokens.contains(&"bar".to_string()));
    }

    #[test]
    fn tokenize_empty_input() {
        let tokens = tokenize_and_filter("");
        assert!(tokens.is_empty());
    }

    #[test]
    fn tokenize_all_stopwords() {
        let tokens = tokenize_and_filter("the a an is are");
        assert!(tokens.is_empty());
    }

    #[test]
    fn score_full_match() {
        let keywords = tokenize_and_filter("rust programming language");
        let score = score_text(&keywords, "Rust is a systems programming language");
        assert!((score - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn score_partial_match() {
        let keywords = tokenize_and_filter("rust programming language");
        let score = score_text(&keywords, "I love rust");
        // "rust" matches out of ["rust", "programming", "language"]
        assert!((score - 1.0 / 3.0).abs() < 0.01);
    }

    #[test]
    fn score_no_match() {
        let keywords = tokenize_and_filter("rust programming");
        let score = score_text(&keywords, "python web framework");
        assert!((score - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn score_empty_keywords() {
        let keywords: Vec<String> = vec![];
        let score = score_text(&keywords, "some text");
        assert!((score - 0.0).abs() < f64::EPSILON);
    }

    fn setup_wallet() -> (Wallet, TempDir) {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (wallet, _phrase) = Wallet::init(&wallet_dir, None).unwrap();
        (wallet, dir)
    }

    #[test]
    fn full_context_empty_wallet() {
        let (wallet, _dir) = setup_wallet();
        let ctx = wallet.get_full_context().unwrap();
        assert!(ctx.contains("# SAID Identity Context"));
        assert!(ctx.contains("## System Prompt"));
        assert!(ctx.contains("(none)"));
        assert!(ctx.contains("## Memories"));
        assert!(ctx.contains("## Preferences"));
        assert!(ctx.contains("## Knowledge"));
    }

    #[test]
    fn full_context_with_data() {
        let (wallet, _dir) = setup_wallet();

        // Add a system prompt
        let prompt = SystemPrompt {
            id: uuid::Uuid::new_v4(),
            name: "default".to_string(),
            content: "You are a helpful assistant.".to_string(),
            tags: vec![],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        wallet.storage().save("prompts", &[prompt]).unwrap();

        // Add memories
        let mem = Memory {
            id: uuid::Uuid::new_v4(),
            content: "User prefers Rust".to_string(),
            tags: vec!["lang".to_string()],
            source_provider: None,
            created_at: chrono::Utc::now(),
        };
        wallet.storage().save("memories", &[mem]).unwrap();

        // Add preferences
        let pref = Preference {
            key: "code.language".to_string(),
            value: serde_json::json!("rust"),
            updated_at: chrono::Utc::now(),
        };
        wallet.storage().save("preferences", &[pref]).unwrap();

        // Add knowledge
        let doc = KnowledgeDoc {
            id: uuid::Uuid::new_v4(),
            title: "Rust Guide".to_string(),
            content: "Rust is a systems programming language.".to_string(),
            tags: vec!["rust".to_string()],
            created_at: chrono::Utc::now(),
        };
        wallet.storage().save("knowledge", &[doc]).unwrap();

        let ctx = wallet.get_full_context().unwrap();
        assert!(ctx.contains("You are a helpful assistant."));
        assert!(ctx.contains("- User prefers Rust"));
        assert!(ctx.contains("- code.language: \"rust\""));
        assert!(ctx.contains("- Rust Guide: Rust is a systems programming language."));
    }

    #[test]
    fn relevant_context_filters_by_topic() {
        let (wallet, _dir) = setup_wallet();

        let mem1 = Memory {
            id: uuid::Uuid::new_v4(),
            content: "User prefers Rust for backend".to_string(),
            tags: vec!["rust".to_string()],
            source_provider: None,
            created_at: chrono::Utc::now(),
        };
        let mem2 = Memory {
            id: uuid::Uuid::new_v4(),
            content: "User likes Python for scripting".to_string(),
            tags: vec!["python".to_string()],
            source_provider: None,
            created_at: chrono::Utc::now(),
        };
        wallet.storage().save("memories", &[mem1, mem2]).unwrap();

        let ctx = wallet.get_relevant_context("rust backend", 5).unwrap();
        assert!(ctx.contains("# SAID Relevant Context"));
        // Rust memory should appear with a score
        assert!(ctx.contains("User prefers Rust for backend"));
        assert!(ctx.contains("score:"));
        // Python memory should not appear (no keyword overlap with "rust backend")
        assert!(!ctx.contains("Python for scripting"));
    }

    #[test]
    fn relevant_context_respects_limit() {
        let (wallet, _dir) = setup_wallet();

        let memories: Vec<Memory> = (0..10)
            .map(|i| Memory {
                id: uuid::Uuid::new_v4(),
                content: format!("rust fact number {}", i),
                tags: vec!["rust".to_string()],
                source_provider: None,
                created_at: chrono::Utc::now(),
            })
            .collect();
        wallet.storage().save("memories", &memories).unwrap();

        let ctx = wallet.get_relevant_context("rust", 3).unwrap();
        let count = ctx.matches("(score:").count();
        assert_eq!(count, 3);
    }

    #[test]
    fn relevant_context_empty_wallet() {
        let (wallet, _dir) = setup_wallet();
        let ctx = wallet.get_relevant_context("anything", 5).unwrap();
        assert!(ctx.contains("# SAID Relevant Context"));
        assert!(ctx.contains("(not relevant)"));
        assert!(ctx.contains("(none)"));
    }
}
