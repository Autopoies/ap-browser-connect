//! One discovery path for media, --list, --auto and Vimeo downloads.
use super::*;

pub(super) struct Page {
    pub tab: Option<i64>,
    pub profile: Option<String>,
    owned: Vec<i64>,
    origin_tab: Option<i64>,
}

impl Page {
    pub fn new(args: &[String]) -> Result<Self> {
        let mut page = Self {
            tab: extract_tab(args),
            // Pin the resolved instance for the entire operation (including tab cleanup).
            profile: Some(crate::socket_client::resolve_socket(
                extract_profile(args).as_deref(),
            )?),
            owned: vec![],
            origin_tab: None,
        };
        if page.tab.is_none() {
            if let Some(url) = download_url(args) {
                page.open(&url)?;
            } else {
                page.tab = resolve_active_tab(&page.profile_args())?;
            }
        }
        page.origin_tab = page.tab.filter(|tab| !page.owned.contains(tab));
        Ok(page)
    }

    pub fn reusable_tab(&self) -> Option<i64> {
        self.origin_tab
    }

    fn profile_args(&self) -> Vec<String> {
        self.profile
            .as_ref()
            .map(|p| vec!["--profile".into(), p.clone()])
            .unwrap_or_default()
    }

    fn args(&self) -> Vec<String> {
        let mut args = self.profile_args();
        if let Some(tab) = self.tab {
            args.extend(["--tab".into(), tab.to_string()]);
        }
        args
    }

    fn open(&mut self, url: &str) -> Result<()> {
        stream::validate_url(url)?;
        let response = rpc(
            "tabs.new",
            json!({"url": url, "active": false}),
            &self.profile_args(),
        )?;
        let tab = response["data"]["id"]
            .as_i64()
            .ok_or_else(|| anyhow!("could not open a silent download tab"))?;
        self.owned.push(tab);
        self.tab = Some(tab);
        let response = rpc(
            "wait",
            json!({
                "until_eval": "document.readyState !== 'loading' && (location.hostname !== 'player.vimeo.com' || Boolean(window.playerConfig?.request?.files))",
                "timeout_ms": 20000,
            }),
            &self.args(),
        )?;
        if response["ok"] == false {
            bail!("download page did not load; open the player and retry with --tab");
        }
        Ok(())
    }

    fn collect(&self, mode: &str, args: &[String]) -> Result<Value> {
        let config = DownloadConfig::load();
        let network = rpc("dev.network.list", json!({}), &self.args())
            .ok()
            .and_then(|r| r["data"]["requests"].as_array().cloned())
            .unwrap_or_default();
        let options = json!({"mode": mode, "media_type": flag_value(args, "--type").unwrap_or("all".into()),
            "extensions": config.extensions, "url_patterns": config.url_patterns, "network": network});
        let expression = format!("{}({options})", include_str!("discovery.js"));
        let result = cdp_eval(self.tab, self.profile.as_deref(), &expression)?;
        if !result["items"].is_array() {
            bail!("media discovery did not return page data");
        }
        Ok(result)
    }

    pub fn discover(&mut self, mode: &str, args: &[String]) -> Result<Value> {
        let mut result = self.collect(mode, args)?;
        // A normal vimeo.com page embeds a cross-origin player. Reuse its exact
        // iframe URL (including the unlisted hash) in an owned silent tab, never
        // navigate the user's tab or guess/fetch a /config URL.
        let frames = result["player_frames"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let has_config = result["items"]
            .as_array()
            .is_some_and(|items| items.iter().any(|i| i["source"] == "player-config"));
        if !has_config && frames.len() == 1 {
            if let Some(url) = frames[0].as_str() {
                self.open(url)?;
                let child = self.collect(mode, args)?;
                for field in ["items", "media"] {
                    if let (Some(dest), Some(src)) =
                        (result[field].as_array_mut(), child[field].as_array())
                    {
                        for item in src {
                            if !dest.iter().any(|i| {
                                i["url"] == item["url"]
                                    && i["program_index"] == item["program_index"]
                            }) {
                                dest.push(item.clone());
                            }
                        }
                    }
                }
            }
        }
        if let Some(items) = result["items"].as_array_mut() {
            for (id, item) in items.iter_mut().enumerate() {
                item["id"] = json!(id);
            }
        }
        Ok(result)
    }
}

impl Drop for Page {
    fn drop(&mut self) {
        for tab in &self.owned {
            let _ = rpc("tabs.close", json!({"tab_id": tab}), &self.profile_args());
        }
    }
}

pub(super) fn choose_auto(items: &[Value], video_only: bool) -> Result<&Value> {
    let candidates: Vec<_> = items
        .iter()
        .filter(|i| !video_only || matches!(i["type"].as_str(), Some("hls" | "dash" | "video")))
        .collect();
    let prefer_config = video_only && candidates.iter().any(|i| i["source"] == "player-config");
    let candidates: Vec<_> = candidates
        .into_iter()
        .filter(|i| !prefer_config || i["source"] == "player-config")
        .collect();
    let priority = candidates
        .iter()
        .filter_map(|i| i["priority"].as_u64())
        .min()
        .unwrap_or(99);
    let top: Vec<_> = candidates
        .into_iter()
        .filter(|i| i["priority"].as_u64().unwrap_or(99) == priority)
        .collect();
    match top.as_slice() {
        [] => bail!("no downloadable items found on this page; load the player or pass --hls <manifest-url>"),
        [item] => Ok(item),
        _ => bail!("ambiguous: {} candidates at top priority; use --list + --pick <id>", top.len()),
    }
}
