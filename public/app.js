const $ = id => document.getElementById(id);
let generatedImage = null;
let uploadedThumb = null;
async function api(url, options={}) {
  const r = await fetch(url, options);
  const data = await r.json().catch(()=>({error:"استجابة غير مفهومة من الخادم"}));
  if (!r.ok) throw new Error(data.error || `خطأ ${r.status}`);
  return data;
}
function busy(button, on, label) { button.disabled=on; if(on){button.dataset.old=button.textContent;button.textContent=label;} else button.textContent=button.dataset.old || button.textContent; }
async function refreshStatus(){
  try {
    const s=await api("/api/status");
    $("connection").textContent=s.connected?"القناة متصلة ✓":s.oauthConfigured?"القناة غير متصلة":"إعداد ربط يوتيوب ناقص";
    $("connection").className="pill "+(s.connected?"good":"");
    $("channelText").textContent=s.channel?`متصل بالقناة: ${s.channel.title}`:"اربط حساب Google المرتبط بقناتك للنشر مباشرة.";
    $("connectBtn").classList.toggle("hidden",s.connected);
    $("disconnectBtn").classList.toggle("hidden",!s.connected);
    if(!s.aiConfigured) $("generateBtn").title="يلزم إضافة GEMINI_API_KEY في إعدادات الاستضافة.";
  } catch(e){$("connection").textContent="تعذر فحص الاتصال";}
}
$("video").addEventListener("change",e=>$("fileName").textContent=e.target.files[0]?.name||"");
$("generateBtn").onclick=async()=>{
  const b=$("generateBtn"); busy(b,true,"جاري تجهيز العنوان والوصف...");
  try{
    const d=await api("/api/generate-metadata",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({topic:$("topic").value,extra:$("extra").value})});
    $("title").value=d.title||""; $("description").value=d.description||"";
    $("tags").value=(d.tags||[]).join(", "); $("hashtags").value=(d.hashtags||[]).join(" ");
  }catch(e){alert(e.message)}finally{busy(b,false)}
};
$("makeImageBtn").onclick=async()=>{
  const b=$("makeImageBtn"); busy(b,true,"جاري توليد الصورة...");
  try{
    const d=await api("/api/generate-thumbnail",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:$("imagePrompt").value||$("topic").value})});
    generatedImage=d.image; uploadedThumb=null; $("preview").src=d.image; $("preview").classList.remove("hidden"); $("imageStatus").textContent="الصورة جاهزة، وسيتم رفعها بعد نشر الفيديو.";
  }catch(e){alert(e.message)}finally{busy(b,false)}
};
$("thumbnail").onchange=e=>{
  uploadedThumb=e.target.files[0]||null; generatedImage=null;
  if(uploadedThumb){$("preview").src=URL.createObjectURL(uploadedThumb);$("preview").classList.remove("hidden");$("imageStatus").textContent="تم اختيار صورتك وستُرفع بعد نشر الفيديو."}
};
$("disconnectBtn").onclick=async()=>{if(!confirm("هل تريد فصل القناة؟"))return;await api("/api/disconnect",{method:"POST"});refreshStatus()};
$("publishBtn").onclick=async()=>{
  const video=$("video").files[0];
  if(!video)return alert("اختار ملف الفيديو أولاً.");
  if(!$("title").value.trim())return alert("اكتب عنوان الفيديو أو ولّده أولاً.");
  if(!confirm("تأكيد رفع الفيديو إلى القناة؟"))return;
  const b=$("publishBtn");busy(b,true,"جاري رفع الفيديو إلى يوتيوب...");
  $("result").textContent="قد يستغرق الرفع بعض الوقت حسب حجم الفيديو وسرعة الإنترنت. لا تغلق الصفحة.";
  try{
    const fd=new FormData();fd.append("video",video);fd.append("title",$("title").value);
    fd.append("description",$("description").value);fd.append("tags",$("tags").value);
    fd.append("privacy",$("privacy").value);fd.append("madeForKids",$("kids").checked?"true":"false");
    const d=await api("/api/upload",{method:"POST",body:fd});
    if(generatedImage||uploadedThumb){
      const tf=new FormData();tf.append("videoId",d.videoId);
      if(uploadedThumb)tf.append("thumbnail",uploadedThumb);
      else {
        const blob=await (await fetch(generatedImage)).blob();
        tf.append("thumbnail",new File([blob],"thumbnail.png",{type:blob.type||"image/png"}));
      }
      try{await api("/api/thumbnail",{method:"POST",body:tf});}
      catch(e){$("result").innerHTML=`<p class="warn">تم رفع الفيديو، لكن تعذر تعيين الصورة المصغرة: ${e.message}</p><a target="_blank" href="${d.url}">فتح الفيديو على يوتيوب</a>`;return;}
    }
    $("result").innerHTML=`<p class="success">تم رفع الفيديو بنجاح!</p><a target="_blank" rel="noopener" href="${d.url}">مشاهدة الفيديو على YouTube</a>`;
  }catch(e){$("result").textContent="تعذر النشر: "+e.message}
  finally{busy(b,false)}
};
refreshStatus();
