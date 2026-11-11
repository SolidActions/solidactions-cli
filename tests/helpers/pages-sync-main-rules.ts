/** Pinned copy of app PagesSyncRequest rules, app main blob 16571244ff0d9de5adf94dac069ccb187d864867. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SOURCE_KINDS = ['sql', 'connection', 'pegs'];

export function validatesAgainstAppMain(payload: any): string[] {
    const errors: string[] = [];
    if (!Array.isArray(payload.pages) || payload.pages.length > 50) errors.push('pages: present array, max 50');
    for (const [i, page] of (payload.pages ?? []).entries()) {
        const at = `pages.${i}`;
        if (typeof page.slug !== 'string' || !SLUG.test(page.slug)) errors.push(`${at}.slug`);
        if (typeof page.name !== 'string' || page.name.length > 255) errors.push(`${at}.name`);
        if (!['visual', 'dashboard'].includes(page.kind)) errors.push(`${at}.kind`);
        if (typeof page.path !== 'string' || page.path.length > 255) errors.push(`${at}.path`);
        if (typeof page.home !== 'boolean') errors.push(`${at}.home`);
        if (typeof page.body !== 'string' || Buffer.byteLength(page.body) > 1048576) errors.push(`${at}.body`);
        if (page.sources !== undefined && page.sources !== null) {
            if (!Array.isArray(page.sources) || page.sources.length > 50) errors.push(`${at}.sources: array, max 50`);
            else for (const [j, source] of page.sources.entries()) {
                if (typeof source !== 'object' || source === null || Array.isArray(source)) errors.push(`${at}.sources.${j}: array/object`);
                else {
                    if (typeof source.key !== 'string') errors.push(`${at}.sources.${j}.key`);
                    if (!SOURCE_KINDS.includes(source.kind)) errors.push(`${at}.sources.${j}.kind`);
                }
            }
        }
    }
    return errors;
}
