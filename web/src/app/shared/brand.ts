/** The RB ABC logo. Replace web/public/logo.png with your own image (same file name) to change it everywhere:
 *  sidebar, login page, dashboard, printed documents, browser tab and the default profile picture. */
export const LOGO = 'logo.png';

/** Full address of the logo — printed documents open in a separate frame and need it. */
export function logoUrl(): string {
  return new URL(LOGO, document.baseURI).href;
}

/** Logo block printed at the top of the DN, RR, SOA and PO. */
export function printBrand(): string {
  return `<div class="brand"><img src="${logoUrl()}" alt="" style="width:64px;height:64px;object-fit:contain;display:block;margin:0 auto 6px">` +
    '<b>RABIES BUSTER</b><span>ANIMAL BITE CENTER</span><i>“Vaccinating people against Rabies since 2019”</i></div>';
}
