// Source Skill/documentation checks against the freshly built public CLI.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, access } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec=promisify(execFile),repo=fileURLToPath(new URL("../",import.meta.url));
const cli=resolve(repo,process.env.CARGO_TARGET_DIR||"target","debug/ap-browser");

test("canonical recording links resolve; source entry/menu disclose snapshot limits",async()=>{
	let links=0;
	for(const file of ["README.md","skill/SKILL.md","skill/references/recording.md"]){
		const text=await readFile(join(repo,file),"utf8");
		assert.ok(!/v2-receipts|subagent-artifacts|\/Users\/|Gemini3/.test(text),"no private receipts or provider lock-in");
		for(const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){
			const href=match[1];if(/^(https?:|mailto:)/.test(href))continue;
			const [path,anchor]=href.split("#"),target=path?resolve(dirname(join(repo,file)),path):join(repo,file);
			await access(target);links++;
			if(anchor && target.endsWith("/recording.md")){const body=await readFile(target,"utf8");const anchors=[...body.matchAll(/^#+\s+(.+)$/gm)].map(m=>m[1].toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu,"").replace(/ /g,"-"));assert.ok(anchors.includes(anchor),`${file}: missing ${href}`);}
		}
	}
	const text=await readFile(join(repo,"skill/references/recording.md"),"utf8");
	for(const field of ["cdp_capture_screenshot","request_started_ms","response_received_ms","geometry_validated_ms","persisted_without_end","durable_lower_bound","schema1","--out"])assert.ok(text.includes(field),field);
	assert.ok(links>10);
});

test("every recording shell example flag/subcommand exists in fresh --help; Template example is actual v1",async()=>{
	const docs=(await Promise.all(["README.md","skill/references/recording.md"].map(p=>readFile(join(repo,p),"utf8")))).join("\n");
	let examples=0;const cache=new Map();
	for(const block of docs.matchAll(/```(?:sh|bash)\n([\s\S]*?)\n```/g))for(const line of block[1].split("\n")){
		if(!/^ap-browser\s/.test(line)||!line.includes(" record"))continue;
		const args=line.slice(line.indexOf(" record")+7).trim().split(/\s+/),sub=args[0].startsWith("--")?null:args[0];
		const helpArgs=["record",...(sub?[sub]:[]),"--help"],key=helpArgs.join(" ");
		if(!cache.has(key))cache.set(key,(await exec(cli,helpArgs,{timeout:5000})).stdout);
		const help=cache.get(key);assert.ok(help.includes("Usage: ap-browser record"));
		for(const flag of line.match(/--[a-z][a-z-]*/g)||[])assert.ok(help.includes(flag),`${key} lacks ${flag}`);
		examples++;
	}
	assert.ok(examples>=15);
	const ref=await readFile(join(repo,"skill/references/recording.md"),"utf8"),template=JSON.parse(ref.match(/```json\n([\s\S]*?)\n```/)[1]);
	assert.equal(template.version,1);assert.equal(template.layout,"strip");assert.equal(template.items[0].text.kind,"template");
});
