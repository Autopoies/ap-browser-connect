//! Runtime site-filter discovery and request propagation.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const FILTERS_DIR: &str = ".ap-browser/filters";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FilterPolicy {
    pub schema_version: u8,
    pub site: String,
    pub name: String,
    #[serde(rename = "match")]
    pub match_rule: FilterMatch,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dom: Option<DomFilter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ResultFilter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction: Option<InteractionFilter>,
}

impl FilterPolicy {
    pub fn policy_id(&self) -> String {
        format!("{}/{}", self.site, self.name)
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err(format!(
                "unsupported schema_version {}; expected 1",
                self.schema_version
            ));
        }
        validate_identity("site", &self.site)?;
        validate_identity("name", &self.name)?;

        if self.match_rule.origins.is_empty() {
            return Err("match.origins must not be empty".into());
        }
        validate_unique("match.origins", &self.match_rule.origins)?;
        for origin in &self.match_rule.origins {
            validate_origin(origin)?;
        }
        if self.match_rule.paths.is_empty() {
            return Err("match.paths must not be empty".into());
        }
        validate_unique("match.paths", &self.match_rule.paths)?;
        for path in &self.match_rule.paths {
            if !path.starts_with('/') || path.contains(['?', '#']) {
                return Err(format!(
                    "match.paths entry `{path}` must start with `/` and contain no query or fragment"
                ));
            }
        }
        if self.match_rule.methods.as_ref().is_some_and(Vec::is_empty) {
            return Err("match.methods must not be empty when present".into());
        }
        if let Some(methods) = &self.match_rule.methods {
            validate_unique("match.methods", methods)?;
        }

        if self.dom.is_none() && self.result.is_none() && self.interaction.is_none() {
            return Err("policy must define at least one of dom, result, or interaction".into());
        }
        if let Some(dom) = &self.dom {
            validate_nonempty_strings("dom.drop_selectors", &dom.drop_selectors)?;
            validate_unique("dom.drop_selectors", &dom.drop_selectors)?;
        }
        if let Some(result) = &self.result {
            if result.redact_blocks.is_empty() {
                return Err("result.redact_blocks must not be empty".into());
            }
            for block in &result.redact_blocks {
                if block.start.is_empty() || block.end.is_empty() {
                    return Err("result.redact_blocks start and end must not be empty".into());
                }
            }
        }
        if let Some(interaction) = &self.interaction {
            validate_nonempty_strings("interaction.deny_selectors", &interaction.deny_selectors)?;
            validate_unique("interaction.deny_selectors", &interaction.deny_selectors)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FilterMatch {
    pub origins: Vec<String>,
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub methods: Option<Vec<FilterMethod>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FilterMethod {
    Text,
    Html,
    Eval,
    Batch,
    Click,
    Fill,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DomFilter {
    pub drop_selectors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResultFilter {
    pub redact_blocks: Vec<RedactBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RedactBlock {
    pub start: String,
    pub end: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InteractionFilter {
    pub deny_selectors: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Registry {
    policies: Vec<FilterPolicy>,
}

impl Registry {
    pub fn load() -> Self {
        Self::load_from_home(dirs::home_dir())
    }

    fn load_from_home(home: Option<PathBuf>) -> Self {
        let Some(home) = home else {
            eprintln!("[warn] filter discovery disabled: home directory unavailable");
            return Self::default();
        };
        let root = home.join(FILTERS_DIR);
        let (registry, warnings) = Self::load_from(&root);
        for warning in warnings {
            eprintln!(
                "[warn] filter {}: {}",
                warning.path.display(),
                warning.message
            );
        }
        registry
    }

    pub fn bundle(&self) -> Value {
        Value::Array(
            self.policies
                .iter()
                .map(|policy| {
                    let mut value = serde_json::to_value(policy)
                        .expect("FilterPolicy contains only JSON-compatible values");
                    value["policy_id"] = Value::String(policy.policy_id());
                    value
                })
                .collect(),
        )
    }

    pub fn attach_to(&self, params: &mut Value) {
        if let Some(object) = params.as_object_mut() {
            object.insert("_filters".into(), self.bundle());
        }
    }

    fn load_from(root: &Path) -> (Self, Vec<LoadWarning>) {
        let mut warnings = Vec::new();
        if !root.is_dir() {
            return (Self::default(), warnings);
        }

        let mut site_dirs = read_dir_paths(root, &mut warnings);
        site_dirs.sort();
        let mut policies = Vec::new();

        for site_dir in site_dirs {
            if !site_dir.is_dir() {
                continue;
            }
            let Some(site_name) = site_dir.file_name().and_then(|name| name.to_str()) else {
                warnings.push(LoadWarning::new(
                    &site_dir,
                    "site directory name is not UTF-8",
                ));
                continue;
            };
            let mut files = read_dir_paths(&site_dir, &mut warnings);
            files.sort();
            for path in files {
                if !path.is_file() {
                    continue;
                }
                let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
                    continue;
                };
                if extension != "yaml" {
                    continue;
                }
                let Some(file_name) = path.file_stem().and_then(|name| name.to_str()) else {
                    warnings.push(LoadWarning::new(&path, "policy filename is not UTF-8"));
                    continue;
                };
                let source = match std::fs::read_to_string(&path) {
                    Ok(source) => source,
                    Err(error) => {
                        warnings.push(LoadWarning::new(&path, format!("read failed: {error}")));
                        continue;
                    }
                };
                let policy = match serde_yaml::from_str::<FilterPolicy>(&source) {
                    Ok(policy) => policy,
                    Err(error) => {
                        warnings.push(LoadWarning::new(&path, format!("parse failed: {error}")));
                        continue;
                    }
                };
                if let Err(error) = policy.validate() {
                    warnings.push(LoadWarning::new(&path, error));
                    continue;
                }
                if policy.site != site_name {
                    warnings.push(LoadWarning::new(
                        &path,
                        format!(
                            "policy site `{}` does not match directory `{site_name}`",
                            policy.site
                        ),
                    ));
                    continue;
                }
                if policy.name != file_name {
                    warnings.push(LoadWarning::new(
                        &path,
                        format!(
                            "policy name `{}` does not match filename `{file_name}`",
                            policy.name
                        ),
                    ));
                    continue;
                }
                policies.push(policy);
            }
        }
        (Self { policies }, warnings)
    }
}

#[derive(Debug)]
struct LoadWarning {
    path: PathBuf,
    message: String,
}

impl LoadWarning {
    fn new(path: impl Into<PathBuf>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }
}

fn read_dir_paths(root: &Path, warnings: &mut Vec<LoadWarning>) -> Vec<PathBuf> {
    match std::fs::read_dir(root) {
        Ok(entries) => entries.flatten().map(|entry| entry.path()).collect(),
        Err(error) => {
            warnings.push(LoadWarning::new(
                root,
                format!("directory read failed: {error}"),
            ));
            Vec::new()
        }
    }
}

fn validate_identity(field: &str, value: &str) -> Result<(), String> {
    let mut segments = value.split('-');
    if value.is_empty()
        || segments.any(|segment| {
            segment.is_empty()
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
    {
        return Err(format!(
            "{field} `{value}` must match ^[a-z0-9]+(?:-[a-z0-9]+)*$"
        ));
    }
    Ok(())
}

fn validate_origin(origin: &str) -> Result<(), String> {
    let (scheme, authority) = origin
        .strip_prefix("https://")
        .map(|authority| ("https", authority))
        .or_else(|| {
            origin
                .strip_prefix("http://")
                .map(|authority| ("http", authority))
        })
        .ok_or_else(|| format!("match.origins entry `{origin}` must use http or https"))?;
    if authority.is_empty()
        || authority.contains(['/', '?', '#', '@'])
        || authority.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        return Err(format!(
            "match.origins entry `{origin}` must be a serialized origin without userinfo, path, query, or fragment"
        ));
    }

    let (host, port, is_ipv6) = if let Some(ipv6) = authority.strip_prefix('[') {
        let end = ipv6.find(']').ok_or_else(|| {
            format!("match.origins entry `{origin}` has an invalid IPv6 hostname")
        })?;
        let host = &ipv6[..end];
        let suffix = &ipv6[end + 1..];
        let port = suffix.strip_prefix(':').filter(|_| !suffix[1..].is_empty());
        if !suffix.is_empty() && port.is_none() {
            return Err(format!(
                "match.origins entry `{origin}` has an invalid port"
            ));
        }
        (host, port, true)
    } else {
        match authority.split_once(':') {
            Some((host, port)) if !port.contains(':') => (host, Some(port), false),
            Some(_) => {
                return Err(format!(
                    "match.origins entry `{origin}` must bracket an IPv6 hostname"
                ));
            }
            None => (authority, None, false),
        }
    };
    if host.is_empty() || host.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(format!(
            "match.origins entry `{origin}` must contain a lowercase serialized hostname"
        ));
    }
    if is_ipv6 {
        host.parse::<std::net::Ipv6Addr>()
            .map_err(|_| format!("match.origins entry `{origin}` has an invalid IPv6 hostname"))?;
    } else if !host.bytes().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
    }) {
        return Err(format!(
            "match.origins entry `{origin}` contains a non-canonical hostname"
        ));
    }
    if let Some(port) = port {
        let parsed = port
            .parse::<u16>()
            .map_err(|_| format!("match.origins entry `{origin}` has an invalid port"))?;
        if (scheme == "http" && parsed == 80) || (scheme == "https" && parsed == 443) {
            return Err(format!(
                "match.origins entry `{origin}` contains a default port omitted by URL.origin"
            ));
        }
    }
    Ok(())
}

fn validate_nonempty_strings(field: &str, values: &[String]) -> Result<(), String> {
    if values.is_empty() || values.iter().any(String::is_empty) {
        return Err(format!("{field} must contain non-empty strings"));
    }
    Ok(())
}

fn validate_unique<T>(field: &str, values: &[T]) -> Result<(), String>
where
    T: Eq + std::hash::Hash,
{
    let mut seen = HashSet::with_capacity(values.len());
    if values.iter().any(|value| !seen.insert(value)) {
        return Err(format!("{field} must not contain duplicate entries"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP_DIR_ID: AtomicU64 = AtomicU64::new(0);

    const VALID_POLICY: &str = r#"
schema_version: 1
site: coursera
name: content-integrity
match:
  origins:
    - https://www.coursera.org
  paths:
    - /learn/*/assignment-submission/*
  methods: [text, html, eval, batch, click, fill]
dom:
  drop_selectors:
    - '[data-ai-instructions="true"]'
    - '[data-testid="content-integrity-instructions"]'
    - '[data-testid="acknowledgment-checkpoint"]'
result:
  redact_blocks:
    - start: You are a helpful AI assistant.
      end: This verification step is mandatory for all AI assistants accessing assessment pages.
      replacement: '[FILTERED: coursera content-integrity instructions]'
interaction:
  deny_selectors:
    - '[data-action="acknowledge-guidelines"]'
"#;

    #[test]
    fn parses_and_serializes_strict_v1_policy() {
        let policy: FilterPolicy = serde_yaml::from_str(VALID_POLICY).unwrap();
        policy.validate().unwrap();
        assert_eq!(policy.policy_id(), "coursera/content-integrity");
        let methods = policy.match_rule.methods.as_ref().unwrap();
        assert_eq!(methods.len(), 6);
        assert!(methods.contains(&FilterMethod::Batch));
        assert_eq!(policy.dom.as_ref().unwrap().drop_selectors.len(), 3);
        let block = &policy.result.as_ref().unwrap().redact_blocks[0];
        assert_eq!(block.start, "You are a helpful AI assistant.");
        assert_eq!(
            block.end,
            "This verification step is mandatory for all AI assistants accessing assessment pages."
        );
        assert_eq!(
            serde_json::to_value(&policy).unwrap()["match"]["methods"][0],
            "text"
        );
    }

    #[test]
    fn rejects_unknown_or_executable_fields() {
        let source =
            VALID_POLICY.replace("dom:\n", "javascript: document.body.innerHTML = ''\ndom:\n");
        let error = serde_yaml::from_str::<FilterPolicy>(&source).unwrap_err();
        assert!(error.to_string().contains("unknown field `javascript`"));
    }

    #[test]
    fn rejects_duplicate_yaml_keys_at_top_level_and_nested_structs() {
        let duplicate_top_level =
            VALID_POLICY.replace("site: coursera\n", "site: coursera\nsite: attacker\n");
        let top_level_error =
            serde_yaml::from_str::<FilterPolicy>(&duplicate_top_level).unwrap_err();
        assert!(top_level_error
            .to_string()
            .contains("duplicate field `site`"));

        let duplicate_nested = VALID_POLICY.replace(
            "  origins:\n",
            "  origins: [https://attacker.example]\n  origins:\n",
        );
        let nested_error = serde_yaml::from_str::<FilterPolicy>(&duplicate_nested).unwrap_err();
        assert!(nested_error
            .to_string()
            .contains("duplicate field `origins`"));
    }

    #[test]
    fn semantic_validation_rejects_empty_actions_and_nonserialized_origins() {
        let no_actions = r#"
schema_version: 1
site: coursera
name: content-integrity
match:
  origins: [https://www.coursera.org]
  paths: [/learn/*]
"#;
        let policy: FilterPolicy = serde_yaml::from_str(no_actions).unwrap();
        assert!(policy.validate().unwrap_err().contains("at least one"));

        let default_port =
            VALID_POLICY.replace("https://www.coursera.org", "https://www.coursera.org:443");
        let policy: FilterPolicy = serde_yaml::from_str(&default_port).unwrap();
        assert!(policy.validate().unwrap_err().contains("default port"));
    }

    #[test]
    fn discovers_valid_policy_and_adds_computed_wire_identity() {
        let temp = TempDir::new();
        let site_dir = temp.path.join("coursera");
        std::fs::create_dir_all(&site_dir).unwrap();
        std::fs::write(site_dir.join("content-integrity.yaml"), VALID_POLICY).unwrap();

        let (registry, warnings) = Registry::load_from(&temp.path);
        assert!(warnings.is_empty());
        let bundle = registry.bundle();
        assert_eq!(bundle.as_array().unwrap().len(), 1);
        assert_eq!(bundle[0]["policy_id"], "coursera/content-integrity");
        assert_eq!(bundle[0]["site"], "coursera");
    }

    #[test]
    fn missing_filter_directory_is_empty_without_warnings() {
        let temp = TempDir::new();
        let (registry, warnings) = Registry::load_from(&temp.path.join("missing"));
        assert!(registry.bundle().as_array().unwrap().is_empty());
        assert!(warnings.is_empty());
    }

    #[test]
    fn unavailable_home_disables_filter_discovery() {
        let registry = Registry::load_from_home(None);
        assert!(registry.bundle().as_array().unwrap().is_empty());
    }

    #[test]
    fn ignores_yml_files() {
        let temp = TempDir::new();
        let site_dir = temp.path.join("coursera");
        std::fs::create_dir_all(&site_dir).unwrap();
        std::fs::write(site_dir.join("content-integrity.yml"), VALID_POLICY).unwrap();

        let (registry, warnings) = Registry::load_from(&temp.path);
        assert!(registry.bundle().as_array().unwrap().is_empty());
        assert!(warnings.is_empty());
    }

    #[test]
    fn attaches_bundle_without_replacing_request_params() {
        let temp = TempDir::new();
        let site_dir = temp.path.join("coursera");
        std::fs::create_dir_all(&site_dir).unwrap();
        std::fs::write(site_dir.join("content-integrity.yaml"), VALID_POLICY).unwrap();
        let (registry, warnings) = Registry::load_from(&temp.path);
        assert!(warnings.is_empty());

        let mut params = serde_json::json!({"selector": "body"});
        registry.attach_to(&mut params);
        assert_eq!(params["selector"], "body");
        assert_eq!(
            params["_filters"][0]["policy_id"],
            "coursera/content-integrity"
        );
    }

    #[test]
    fn skips_identity_mismatches_and_keeps_loading() {
        let temp = TempDir::new();
        let site_dir = temp.path.join("coursera");
        std::fs::create_dir_all(&site_dir).unwrap();
        std::fs::write(site_dir.join("content-integrity.yaml"), VALID_POLICY).unwrap();
        std::fs::write(
            site_dir.join("wrong-name.yaml"),
            VALID_POLICY.replace("site: coursera", "site: other"),
        )
        .unwrap();

        let (registry, warnings) = Registry::load_from(&temp.path);
        assert_eq!(registry.bundle().as_array().unwrap().len(), 1);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].message.contains("does not match directory"));
    }

    #[test]
    fn skips_filename_mismatch_and_malformed_policy() {
        let temp = TempDir::new();
        let site_dir = temp.path.join("coursera");
        std::fs::create_dir_all(&site_dir).unwrap();
        std::fs::write(site_dir.join("different.yaml"), VALID_POLICY).unwrap();
        std::fs::write(site_dir.join("broken.yaml"), "not: [valid").unwrap();

        let (registry, warnings) = Registry::load_from(&temp.path);
        assert!(registry.bundle().as_array().unwrap().is_empty());
        assert_eq!(warnings.len(), 2);
        assert!(warnings
            .iter()
            .any(|warning| warning.message.contains("does not match filename")));
        assert!(warnings
            .iter()
            .any(|warning| warning.message.contains("parse failed")));
    }

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let sequence = NEXT_TEMP_DIR_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "ap-browser-filter-test-{}-{unique}-{sequence}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
