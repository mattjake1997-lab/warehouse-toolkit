// Company details come from the settings file imported on the toolkit page (see README). The tab sets window.TK.
const TK = (typeof window !== "undefined" && window.TK) || {};
export default TK;
export const brandName = (TK.brand && TK.brand.name) || "";
export const brandLogo = (TK.brand && TK.brand.logo) || "";
// Off-site subinventory -> short warehouse code, e.g. { "ORG.WSI": "WSI" }
export const offsiteCodes = TK.offsite || {};
export const sites = TK.sites || [];
