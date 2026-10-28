import { plainText } from './connect-link';

/** A text style applied after stripping, e.g. chalk.red. */
export type Style = (text: string) => string;

/**
 * stdout: strip control bytes with plainText, then apply the optional style.
 * The style runs after stripping so plainText never eats the style's own
 * escape codes. This is the only stdout path the connection commands use.
 */
export function out(text: string, style?: Style): void {
    const clean = plainText(text);
    console.log(style ? style(clean) : clean);
}

/**
 * stderr: strip control bytes with plainText, then apply the optional style.
 * This is the only stderr path the connection commands use.
 */
export function err(text: string, style?: Style): void {
    const clean = plainText(text);
    console.error(style ? style(clean) : clean);
}
