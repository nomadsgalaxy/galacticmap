// INDEPENDENT verifier for orthogonalRoute.ts (spec §11 Test Matrix).
// Written by the verifier (NOT the implementer). Imports the SHIPPING router and re-asserts the
// hard matrix cases from scratch with its own parser + its own geometry checks, so a green run is
// not a tautology of the implementer's own test harness.
//
//     npx tsx scripts/verify-orthroute-independent.mjs

import {
  orthRoute,
  routeAround,
  pathThroughPoints,
} from "../app/(editor)/boards/[id]/_components/edges/orthogonalRoute.ts";

const EPS = 0.5;
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail = "") {
  if (cond) pass++;
  else { fail++; fails.push(`${name}${detail ? " :: " + detail : ""}`); }
}

// ── independent path parser: M/L/Q/C → ideal corner polyline (Q control = real corner) ──
function corners(d) {
  if (!d) return [];
  const t = d.trim().split(/\s+/);
  const out = [];
  let i = 0;
  const pt = () => { const [x, y] = t[i++].split(",").map(Number); return { x, y }; };
  while (i < t.length) {
    const c = t[i++];
    if (c === "M") out.push(pt());
    else if (c === "L") { const p = pt(); if (t[i] === "Q") {/*trim, drop*/} else out.push(p); }
    else if (c === "Q") { const ctrl = pt(); pt(); out.push(ctrl); }
    else if (c === "C") { pt(); pt(); out.push(pt()); }
    else throw new Error("bad cmd " + c);
  }
  const dedup = [];
  for (const p of out) {
    const q = dedup[dedup.length - 1];
    if (q && Math.abs(q.x - p.x) < EPS && Math.abs(q.y - p.y) < EPS) continue;
    dedup.push(p);
  }
  return dedup;
}
function bends(cs) {
  let b = 0;
  for (let i = 1; i < cs.length - 1; i++) {
    const ax = cs[i].x - cs[i - 1].x, ay = cs[i].y - cs[i - 1].y;
    const bx = cs[i + 1].x - cs[i].x, by = cs[i + 1].y - cs[i].y;
    if (Math.abs(ax * by - ay * bx) > EPS) b++;
  }
  return b;
}
const axisAligned = (cs) => cs.every((p, i) => i === 0 || Math.abs(cs[i - 1].x - p.x) < EPS || Math.abs(cs[i - 1].y - p.y) < EPS);
const noNaN = (d) => !/NaN|Infinity|undefined/.test(d);
const single = (d) => (d.match(/M/g) || []).length === 1 && !/[ZzAa]/.test(d);
const monotone = (cs, ax) => { let dir = 0; for (let i = 1; i < cs.length; i++) { const dd = cs[i][ax] - cs[i - 1][ax]; if (Math.abs(dd) < EPS) continue; const s = Math.sign(dd); if (!dir) dir = s; else if (s !== dir) return false; } return true; };
const strictIn = (r, p) => p.x > r.x + EPS && p.x < r.x + r.width - EPS && p.y > r.y + EPS && p.y < r.y + r.height - EPS;
const interiorOutside = (cs, r) => cs.slice(1, -1).every((p) => !strictIn(r, p));
const near = (a, b) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

const OR = (S, T, sp, tp, x = {}) => orthRoute({ source: S, target: T, sourcePosition: sp, targetPosition: tp, stub: 32, radius: 10, ...x });

// ── §11.1 I / aligned ──
{ const cs = corners(OR({x:0,y:0},{x:200,y:0},"right","left")[0]); ok("straight-horizontal BENDS0", bends(cs)===0, "bends="+bends(cs)); ok("straight-horizontal mono", monotone(cs,"x")); }
{ const cs = corners(OR({x:0,y:0},{x:0,y:200},"bottom","top")[0]); ok("straight-vertical BENDS0", bends(cs)===0); }
{ const cs = corners(OR({x:0,y:0},{x:200,y:0.3},"right","left")[0]); ok("straight-offset-tiny BENDS0", bends(cs)===0, "bends="+bends(cs)); }
// THE headline I-vs-U fix: facing+aligned offset (y=30 both) must be straight, not a U.
{ const r = OR({x:100,y:30},{x:400,y:30},"right","left"); const cs = corners(r[0]); ok("I-aligned-facing BENDS0", bends(cs)===0, "bends="+bends(cs)+" "+JSON.stringify(cs)); ok("I-aligned-facing starts", near(cs[0],{x:100,y:30})); ok("I-aligned-facing ends", near(cs[cs.length-1],{x:400,y:30})); }

// ── §11.2 L ──
{ const cs = corners(OR({x:0,y:0},{x:200,y:-200},"right","bottom")[0]); ok("L-right-to-top BENDS1", bends(cs)===1, "bends="+bends(cs)); ok("L-right-to-top axis", axisAligned(cs)); }
{ const cs = corners(OR({x:0,y:0},{x:200,y:200},"bottom","left")[0]); ok("L-bottom-to-left BENDS1", bends(cs)===1); ok("L-bottom-to-left leaves-bottom", cs.length>=2 && (cs[1].y-cs[0].y)>0); }
{ const r = OR({x:0,y:0},{x:0.2,y:200},"right","bottom"); ok("L-degenerate axis+noNaN", axisAligned(corners(r[0])) && noNaN(r[0])); }
// MIXED-U-behind: corner would reverse source stub; first leg must still go +x, no reversal of +x.
{ const cs = corners(OR({x:0,y:0},{x:-40,y:200},"right","bottom")[0]); ok("MIXED-U-behind leaves-right", cs.length>=2 && (cs[1].x-cs[0].x) > 0, JSON.stringify(cs)); ok("MIXED-U-behind axis+noNaN", axisAligned(cs)); }

// ── §11.3 Z ──
{ const cs = corners(OR({x:0,y:0},{x:200,y:80},"right","left")[0]); ok("Z-facing-x BENDS2", bends(cs)===2, "bends="+bends(cs)); const jx = cs.slice(1,-1).map(p=>p.x); ok("Z-facing-x jog-mid~100", jx.some(x=>Math.abs(x-100)<2), JSON.stringify(jx)); }
{ const cs = corners(OR({x:0,y:0},{x:80,y:200},"bottom","top")[0]); ok("Z-facing-y BENDS2", bends(cs)===2); }
{ const cs = corners(OR({x:0,y:0},{x:200,y:0},"right","left")[0]); ok("Z-facing-aligned BENDS0", bends(cs)===0, "bends="+bends(cs)); }
{ const cs = corners(OR({x:100,y:30},{x:400,y:90},"right","left")[0]); const jx = cs.slice(1,-1).map(p=>p.x); ok("Z-jog-in-channel", jx.every(x=>x>131 && x<369), JSON.stringify(jx)); }

// ── §11.4 U / C / behind ──
{ const cs = corners(OR({x:0,y:0},{x:0,y:120},"right","right")[0]); ok("C-both-right BENDS2", bends(cs)===2, "bends="+bends(cs)); const bx = Math.max(...cs.map(p=>p.x)); ok("C-both-right back>=32", bx>=31, "bx="+bx); }
{ const cs = corners(OR({x:0,y:0},{x:120,y:0},"top","top")[0]); ok("C-both-top BENDS2", bends(cs)===2); const by = Math.min(...cs.map(p=>p.y)); ok("C-both-top back<=-1", by<=-1, "by="+by); }
{ const r = OR({x:0,y:0},{x:-200,y:5},"right","left"); ok("U-target-behind axis+noNaN", axisAligned(corners(r[0])) && noNaN(r[0])); ok("U-target-behind ends", near(corners(r[0]).slice(-1)[0],{x:-200,y:5})); }
{ const Rs={x:-60,y:-30,width:60,height:90}; const cs = corners(OR({x:0,y:0},{x:0,y:40},"right","right",{sourceRect:Rs})[0]); ok("U-clears-source OUTSIDE", interiorOutside(cs,Rs), JSON.stringify(cs)); const bx=Math.max(...cs.map(p=>p.x)); ok("U-clears-source jog>=Rs.right+clr", bx>=25, "bx="+bx); }
{ const Rt={x:-60,y:-30,width:60,height:90}; const cs = corners(OR({x:0,y:40},{x:0,y:0},"right","right",{targetRect:Rt})[0]); ok("U-clears-target OUTSIDE", interiorOutside(cs,Rt)); }
{ const Rs={x:0,y:0,width:100,height:60}, Rt={x:-60,y:0,width:80,height:60}; const cs = corners(OR({x:100,y:30},{x:40,y:30},"right","left",{sourceRect:Rs,targetRect:Rt})[0]); ok("U-turn-aligned BENDS4", bends(cs)===4, "bends="+bends(cs)+" "+JSON.stringify(cs)); ok("U-turn-aligned OUTSIDE-Rs", interiorOutside(cs,Rs)); ok("U-turn-aligned OUTSIDE-Rt", interiorOutside(cs,Rt)); }
{ const r = OR({x:0,y:0},{x:0,y:0.2},"right","right"); ok("C-same-side-aligned noNaN+axis", noNaN(r[0]) && axisAligned(corners(r[0]))); }

// ── §11.5 coincident / extreme ──
{ const r = orthRoute({source:{x:50,y:50},target:{x:50,y:50},sourcePosition:"right",targetPosition:"left",stub:14}); ok("coincident-S-eq-T noNaN+label", noNaN(r[0]) && Number.isFinite(r[1]) && Number.isFinite(r[2])); }
{ const r = orthRoute({source:{x:50,y:50},target:{x:50,y:50},sourcePosition:"right",targetPosition:"left",stub:0}); ok("coincident-stub0 noNaN+single", noNaN(r[0]) && single(r[0])); }
{ const r = OR({x:0,y:0},{x:1e-7,y:0},"right","left"); ok("near-coincident noNaN", noNaN(r[0])); }
{ const r = orthRoute({source:{x:0,y:0},target:{x:200,y:0},sourcePosition:"right",targetPosition:"left",stub:-20,radius:10}); ok("negative-stub BENDS0", bends(corners(r[0]))===0 && noNaN(r[0])); }
{ const r = orthRoute({source:{x:NaN,y:0},target:{x:200,y:0},sourcePosition:"right",targetPosition:"left",stub:32,radius:10}); ok("nan-coord noNaN+startsAt0", noNaN(r[0]) && near(corners(r[0])[0],{x:0,y:0})); }
{ const r = orthRoute({source:{x:0,y:0},target:{x:200,y:-200},sourcePosition:"right",targetPosition:"bottom",stub:32,radius:99999}); ok("huge-radius noNaN+ends", noNaN(r[0]) && near(corners(r[0]).slice(-1)[0],{x:200,y:-200})); }
{ const cs = corners(orthRoute({source:{x:0,y:0},target:{x:40,y:0},sourcePosition:"right",targetPosition:"left",stub:32,radius:10})[0]); ok("stub-gt-gap axis+mono", axisAligned(cs) && monotone(cs,"x")); }

// ── §11.6 routeAround ──
const RA = (S,T,sp,tp,x={}) => routeAround({source:S,target:T,sourcePosition:sp,targetPosition:tp,obstacles:[],margin:26,stub:32,radius:10,...x});
ok("around-no-obstacles null", RA({x:0,y:0},{x:300,y:0},"right","left",{obstacles:[]})===null);
ok("around-obstacle-far null", RA({x:0,y:0},{x:300,y:0},"right","left",{obstacles:[{x:0,y:5000,width:60,height:60}]})===null);
{ const r = RA({x:0,y:0},{x:300,y:0},"right","left",{obstacles:[{x:120,y:-40,width:60,height:80}]}); ok("around-single-box non-null", r!==null); if(r){ const cs=corners(r[0]); const inf={x:120-26,y:-40-26,width:60+52,height:80+52}; ok("around-single-box OUTSIDE", interiorOutside(cs,inf), JSON.stringify(cs)); ok("around-single-box ends", near(cs.slice(-1)[0],{x:300,y:0})); ok("around-single-box axis", axisAligned(cs)); } }
ok("around-zero-size null", RA({x:0,y:0},{x:300,y:0},"right","left",{obstacles:[{x:120,y:-40,width:0,height:80}]})===null);
// style parity: avoid route starts at S and leaves +x like the clear route
{ const args={source:{x:0,y:0},target:{x:300,y:0},sourcePosition:"right",targetPosition:"left",stub:32,radius:10}; const avoid=routeAround({...args,obstacles:[{x:120,y:-40,width:60,height:80}],margin:26}); ok("style-parity avoid-non-null", avoid!==null); if(avoid){ const aC=corners(avoid[0]); ok("style-parity avoid-starts-S", near(aC[0],{x:0,y:0})); ok("style-parity avoid-leaves-+x", (aC[1].x-aC[0].x)>0); } }

// ── §11.7 pathThroughPoints ──
{ const r = pathThroughPoints([]); ok("wp-empty", r[0]==="" && r[1]===0 && r[2]===0); }
{ const r = pathThroughPoints([{x:5,y:5}]); ok("wp-single dot", r[0].replace(/\s+/g," ").trim()==="M 5,5" && r[1]===5 && r[2]===5); }
{ ok("wp-collinear-drop BENDS0", bends(corners(pathThroughPoints([{x:0,y:0},{x:50,y:0},{x:100,y:0}])[0]))===0); }
{ ok("wp-collinear-float BENDS0", bends(corners(pathThroughPoints([{x:0,y:0},{x:50,y:0.3},{x:100,y:0}])[0]))===0); }
{ ok("wp-dup-drop noNaN", noNaN(pathThroughPoints([{x:0,y:0},{x:0,y:0.2},{x:40,y:40}])[0])); }
{ const cs = corners(pathThroughPoints([{x:0,y:0},{x:0,y:50},{x:50,y:50}],"snake")[0]); ok("wp-snake axis+BENDS1", axisAligned(cs) && bends(cs)===1); }
{ const r = pathThroughPoints([{x:0,y:0},{x:0,y:50},{x:50,y:50}],"curve"); ok("wp-curve C-only+ends", r[0].includes("C") && !/ L /.test(r[0]) && noNaN(r[0])); }

// ── §11.8 continuity ──
{ const samples=[OR({x:0,y:0},{x:200,y:0},"right","left"),OR({x:0,y:0},{x:200,y:-200},"right","bottom"),OR({x:0,y:0},{x:200,y:80},"right","left"),OR({x:0,y:0},{x:0,y:120},"right","right"),pathThroughPoints([{x:0,y:0},{x:0,y:50},{x:50,y:50}],"snake"),pathThroughPoints([{x:0,y:0},{x:0,y:50},{x:50,y:50}],"curve")]; samples.forEach((r,i)=>ok("single-subpath["+i+"]", single(r[0]))); }
{ const S={x:0,y:0}, Rs={x:-20,y:-20,width:40,height:40}; let prev=null,maxJump=0,anyNaN=false; for(let deg=0;deg<360;deg+=3){ const a=deg*Math.PI/180; const T={x:Math.round(Math.cos(a)*150),y:Math.round(Math.sin(a)*150)}; const sp=Math.abs(Math.cos(a))>=Math.abs(Math.sin(a))?(Math.cos(a)>=0?"right":"left"):(Math.sin(a)>=0?"bottom":"top"); const tp=Math.abs(Math.cos(a))>=Math.abs(Math.sin(a))?(Math.cos(a)>=0?"left":"right"):(Math.sin(a)>=0?"top":"bottom"); const [d]=orthRoute({source:S,target:T,sourcePosition:sp,targetPosition:tp,stub:32,radius:10,sourceRect:Rs}); if(/NaN|Infinity|undefined/.test(d)) anyNaN=true; const b=bends(corners(d)); if(prev!==null) maxJump=Math.max(maxJump,Math.abs(b-prev)); prev=b; } ok("floating-continuity no-NaN", !anyNaN); ok("floating-continuity bounded-jump", maxJump<=4, "maxJump="+maxJump); }

console.log(`\nINDEPENDENT verifier — ${pass} passed, ${fail} failed (${pass+fail} assertions)`);
if (fail) { console.log("\nFAILURES:"); for (const f of fails) console.log("  x " + f); process.exit(1); }
else { console.log("All independent assertions passed."); process.exit(0); }
