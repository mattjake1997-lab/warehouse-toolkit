// Files are saved through the toolkit page, which holds the download permission.
export async function saveAs(blob, filename) {
  try {
    const dl = await window.toolkitUse("downloads");
    if (!dl) { window.toolkitToast && window.toolkitToast("Saving files isn't available in this view"); return; }
    await dl.save({ filename, data: blob });
    window.toolkitToast && window.toolkitToast(`Saved ${filename}`);
  } catch (e) {
    if (e && e.code === "declined") return;
    window.toolkitToast && window.toolkitToast(`Couldn't save ${filename} (${(e && (e.message || e.code)) || "unknown"})`);
  }
}
export default { saveAs };
