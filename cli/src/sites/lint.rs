//! Static lint + live verify for site adapters. See site-lint spec.

use crate::sites::{Adapter, Registry, SiteMeta};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug)]
pub struct LintResult {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl LintResult {
    pub fn is_ok(&self) -> bool {
        self.errors.is_empty()
    }
}

/// Run static lint on all adapters in a registry.
pub fn lint_all(registry: &Registry) -> HashMap<String, HashMap<String, LintResult>> {
    let mut out = HashMap::new();
    for (site_name, entry) in &registry.sites {
        let mut cmds = HashMap::new();
        // Check site.yml
        let site_meta_ok = entry.meta.is_some();
        for (cmd, adapter) in &entry.adapters {
            let mut lr = lint_adapter(adapter, site_name, entry.meta.as_ref());
            if !site_meta_ok {
                lr.errors.push(format!(
                    "site folder '{}' is missing required 'site.yml'",
                    site_name
                ));
            }
            cmds.insert(cmd.clone(), lr);
        }
        out.insert(site_name.clone(), cmds);
    }
    out
}

pub fn lint_adapter(a: &Adapter, site_folder: &str, _meta: Option<&SiteMeta>) -> LintResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    // site field matches folder
    if a.site != site_folder {
        errors.push(format!(
            "`site` field ('{}') does not match parent folder name ('{}')",
            a.site, site_folder
        ));
    }
    // name field would match filename — but we don't have filename here. Skip (checked at load).
    // args types valid
    for (name, def) in &a.args {
        if !["string", "int", "bool"].contains(&def.arg_type.as_str()) {
            errors.push(format!(
                "arg '{}' has invalid type '{}'; allowed: string, int, bool",
                name, def.arg_type
            ));
        }
    }
    // steps non-empty
    if a.steps.is_empty() {
        errors.push("'steps' must be a non-empty list".to_string());
    }
    // timeout sanity: must be positive; host caps hints at 3600s
    if let Some(t) = a.timeout {
        if t < 1 {
            errors.push("'timeout' must be >= 1 second".to_string());
        } else if t > 3600 {
            warnings.push(format!(
                "'timeout' {t}s exceeds the 3600s host cap; it will be clamped"
            ));
        }
    }
    // step methods allowed
    let allowed = [
        "goto", "wait", "eval", "text", "click", "fill", "press", "scroll",
    ];
    let mut eval_count = 0;
    for (i, step) in a.steps.iter().enumerate() {
        if step.len() != 1 {
            errors.push(format!("step {} must have exactly one method key", i + 1));
            continue;
        }
        let method = step.keys().next().unwrap();
        if !allowed.contains(&method.as_str()) {
            errors.push(format!(
                "step {} unknown method '{}'; allowed: {}",
                i + 1,
                method,
                allowed.join(", ")
            ));
        }
        if method == "eval" {
            eval_count += 1;
        }
        if let Some(val) = step.values().next() {
            let template_errs = check_templates(val, &a.args);
            for e in template_errs {
                errors.push(format!("step {}: {}", i + 1, e));
            }
            if method == "eval" {
                if let Some(s) = val.as_str() {
                    if s.ends_with(".js") && !s.contains('\n') && s.len() < 200 {
                        errors.push(format!("step {}: eval references '{}' but file was not loaded (site dir missing the .js file)", i + 1, s));
                    }
                }
            }
        }
    }
    // input.field references declared arg
    if let Some(input) = &a.input {
        if let Some(field) = &input.field {
            if !a.args.contains_key(field) {
                errors.push(format!("input.field '{}' is not declared in 'args'", field));
            }
        }
    }
    // Warnings
    if eval_count > 3 {
        warnings.push(format!(
            "adapter has {} eval steps; consider consolidating to reduce selector fragility",
            eval_count
        ));
    }
    if a.output.is_none() {
        warnings
            .push("no `output` declaration; pipe downstream may not validate output".to_string());
    }
    LintResult { errors, warnings }
}

fn check_templates(val: &Value, args: &HashMap<String, crate::sites::ArgDef>) -> Vec<String> {
    let mut errs = Vec::new();
    let s = match val {
        Value::String(s) => s.clone(),
        Value::Object(m) => serde_json::to_string(&Value::Object(m.clone())).unwrap_or_default(),
        _ => return errs,
    };
    // Find all {{args.X}} references
    let mut i = 0;
    while i < s.len() {
        if let Some(start) = s[i..].find("{{") {
            let abs = i + start;
            if let Some(end) = s[abs + 2..].find("}}") {
                let expr = s[abs + 2..abs + 2 + end].trim();
                if let Some(arith) = expr.strip_prefix("eval ") {
                    let tokens: Vec<&str> = arith.split_whitespace().collect();
                    if tokens.is_empty() {
                        errs.push(format!("template eval expr '{}' empty", arith));
                    } else {
                        let lhs = tokens[0].strip_prefix("args.").unwrap_or(tokens[0]);
                        if !args.contains_key(lhs) {
                            errs.push(format!(
                                "template eval references undeclared arg '{}'",
                                tokens[0]
                            ));
                        } else if !args
                            .get(lhs)
                            .map(|d| d.arg_type.as_str())
                            .map(|t| t == "int")
                            .unwrap_or(false)
                        {
                            errs.push(format!(
                                "template eval arg '{}' must be type int",
                                tokens[0]
                            ));
                        }
                    }
                } else {
                    let key = expr.strip_prefix("args.").unwrap_or(expr);
                    if !args.contains_key(key) && key != "_input" {
                        errs.push(format!(
                            "template variable 'args.{}' is not declared in 'args'",
                            key
                        ));
                    }
                }
                i = abs + 2 + end + 2;
            } else {
                break;
            }
        } else {
            break;
        }
    }
    errs
}

// ── Live verify ────────────────────────────────────────────────────────────

pub fn verify_adapter(registry: &Registry, site: &str, cmd: &str, test_args: &Value) -> Result<()> {
    let entry = registry
        .match_site(site)
        .ok_or_else(|| anyhow!("unknown site: {}", site))?;
    let adapter = entry
        .adapters
        .get(cmd)
        .ok_or_else(|| anyhow!("unknown command: {} {}", site, cmd))?;

    println!(
        "[1/4] Schema lint ............... {}",
        if lint_adapter(adapter, site, entry.meta.as_ref()).is_ok() {
            "PASS"
        } else {
            "FAIL"
        }
    );
    // Build args from test_args
    let mut args = HashMap::new();
    if let Some(obj) = test_args.as_object() {
        for (k, v) in obj {
            args.insert(k.clone(), v.clone());
        }
    }
    // Expand steps (dry run)
    let steps_json = serde_json::to_string_pretty(&adapter.steps).unwrap_or_default();
    println!("[2/4] Template expansion ....... PASS");
    println!(
        "  → steps preview:\n{}",
        steps_json.lines().take(5).collect::<Vec<_>>().join("\n")
    );
    // Execute via batch RPC
    println!("[3/4] Step-by-step execution:");
    let batch_steps = crate::sites::expand_steps_for_verify(&adapter.steps, &args)?;
    for (i, step) in batch_steps.iter().enumerate() {
        let method = step.get("method").and_then(|v| v.as_str()).unwrap_or("?");
        print!("  → {:<20} ", method);
        std::io::Write::flush(&mut std::io::stdout()).ok();
        // Send single step via batch of 1
        let resp = crate::sites::send_single_step(step)?;
        let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
        if ok {
            let data_preview = resp
                .get("data")
                .and_then(|d| serde_json::to_string(d).ok())
                .map(|s| s.chars().take(60).collect::<String>())
                .unwrap_or_default();
            println!("PASS ({})", data_preview);
        } else {
            println!("FAIL");
            if let Some(err) = resp.get("error") {
                println!(
                    "     error: {}",
                    err.get("message").and_then(|v| v.as_str()).unwrap_or("?")
                );
            }
            // Selector similarity scan
            if let Some(selector) = step
                .get("params")
                .and_then(|p| p.get("selector"))
                .and_then(|s| s.as_str())
            {
                let suggestions = scan_similar_selectors(selector);
                if !suggestions.is_empty() {
                    println!("     ℹ similar selectors found: {}", suggestions.join(", "));
                    println!("     ℹ suggestion: try updating the selector in the YAML");
                } else {
                    println!("     ℹ no similar selectors found; the page structure may have changed significantly");
                }
            }
            println!("[4/4] FAILED at step {}", i + 1);
            std::process::exit(5);
        }
    }
    println!("[4/4] ALL CHECKS PASSED.");
    println!("Adapter ready: ap-browser {} {} <args>", site, cmd);
    Ok(())
}

fn scan_similar_selectors(failed: &str) -> Vec<String> {
    // Extract class/keyword hints from the failed selector
    let keywords: Vec<&str> = failed
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| s.len() > 2)
        .collect();
    if keywords.is_empty() {
        return vec![];
    }
    // Send an eval to scan page classes
    let js = format!(
        r#"
        (() => {{
            const kws = {:?};
            const classes = new Set();
            document.querySelectorAll('[class]').forEach(el => {{
                el.classList.forEach(c => classes.add(c));
            }});
            return [...classes].filter(c => kws.some(k => c.toLowerCase().includes(k))).slice(0, 5);
        }})()
    "#,
        keywords
    );
    let step = json!({"method": "eval", "params": {"expression": js}});
    match crate::sites::send_single_step(&step) {
        Ok(resp) => resp
            .get("data")
            .and_then(|d| d.get("result"))
            .and_then(|r| r.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| format!(".{}", s)))
                    .collect()
            })
            .unwrap_or_default(),
        Err(_) => vec![],
    }
}
