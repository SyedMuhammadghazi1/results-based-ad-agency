/**
 * First-party tracking script (dependency-free, ~2 KB).
 * - Reads utm_*, gclid, fbclid, ttclid and oa_cid from the landing URL.
 * - Keeps a random first-party visitor id in the `oa_vid` cookie (180 days, SameSite=Lax).
 * - Posts a touch when tracked parameters are present, and one "ping" per browser session so
 *   the install can be verified. Uses text/plain + keepalive to avoid CORS preflights.
 * - On Shopify storefronts, stores the visitor id as a cart attribute so orders carry it.
 * - Exposes window.OutcomeAds.visitorId() for server-to-server integrations.
 */
const SCRIPT = String.raw`(function(w,d){"use strict";
var s=d.currentScript;if(!s)return;var pk=s.getAttribute("data-key");if(!pk)return;
var api=s.getAttribute("data-api")||s.src.replace(/\/t\.js(\?.*)?$/,"");
var K=["utm_source","utm_medium","utm_campaign","utm_content","utm_term","gclid","fbclid","ttclid","oa_cid"];
function rid(){try{var a=new Uint8Array(16);w.crypto.getRandomValues(a);return Array.prototype.map.call(a,function(b){return("0"+b.toString(16)).slice(-2)}).join("")}catch(e){return(Date.now().toString(36)+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)).slice(0,32)}}
function getC(n){var m=d.cookie.match(new RegExp("(?:^|; )"+n+"=([^;]*)"));return m?decodeURIComponent(m[1]):null}
function setC(n,v){d.cookie=n+"="+encodeURIComponent(v)+"; Max-Age=15552000; Path=/; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"")}
var vid=getC("oa_vid");if(!vid||!/^[A-Za-z0-9_-]{16,64}$/.test(vid)){vid=rid()}setC("oa_vid",vid);
function send(type,params){try{var body=JSON.stringify({pk:pk,vid:vid,type:type,url:location.href,ref:d.referrer||"",params:params});
if(w.fetch){w.fetch(api+"/api/track/touch",{method:"POST",mode:"cors",credentials:"omit",keepalive:true,headers:{"Content-Type":"text/plain"},body:body})["catch"](function(){})}}catch(e){}}
var q={},has=false;try{var u=new URL(location.href);for(var i=0;i<K.length;i++){var v=u.searchParams.get(K[i]);if(v){q[K[i]]=v.slice(0,500);has=true}}}catch(e){}
if(has){send("touch",q)}else{var f="oa_ping_"+pk;try{if(!w.sessionStorage.getItem(f)){w.sessionStorage.setItem(f,"1");send("ping",{})}}catch(e){}}
try{if(w.Shopify&&w.Shopify.shop&&w.fetch){var sk="oa_cart_"+vid;if(!w.sessionStorage.getItem(sk)){w.fetch("/cart/update.js",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({attributes:{oa_vid:vid}})}).then(function(){w.sessionStorage.setItem(sk,"1")})["catch"](function(){})}}}catch(e){}
w.OutcomeAds={visitorId:function(){return vid}};
})(window,document);`;

export const dynamic = "force-static";

export function GET() {
  return new Response(SCRIPT, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}
