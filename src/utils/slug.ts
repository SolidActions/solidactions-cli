/**
 * Project slug generation — shared by `project create` and `project deploy`
 * so the two commands always produce identical slugs for the same input.
 *
 * The server is the authority on slugs (it re-derives/validates on write); this
 * client-side slug is what we send in the POST body and use for follow-up
 * lookups. Keeping it normalized avoids odd values like `foo--bar` or `-foo-`.
 */

/**
 * Normalize a free-text project name into a slug fragment:
 * lowercase, collapse every run of non-alphanumerics to a single hyphen, and
 * trim leading/trailing hyphens. Returns '' when the name has no usable
 * alphanumeric characters (e.g. "!!!" or "你好") — callers should treat an
 * empty result as invalid input.
 */
export function slugifyName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Build the full project slug for an environment. Non-production environments
 * get a `-<environment>` suffix (matching the deploy create flow); production
 * is the bare root slug.
 */
export function buildProjectSlug(name: string, environment: string): string {
    const base = slugifyName(name);
    return environment !== 'production' ? `${base}-${environment}` : base;
}
