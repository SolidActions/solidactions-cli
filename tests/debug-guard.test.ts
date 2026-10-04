/**
 * cli#194: pure tests of the debug guard's functions.
 *
 * Importing the module runs its load-time calls against the real
 * `process.env`, so the vitest process must carry no network NODE_DEBUG.
 */
import { describe, expect, it } from 'vitest';
import { guardDebugNamespaces, nodeDebugNetworkSection } from '../src/utils/debug-guard';

describe('guardDebugNamespaces', () => {
    it('leaves an empty env without a DEBUG key', () => {
        const env: NodeJS.ProcessEnv = {};
        guardDebugNamespaces(env);
        expect(env).toEqual({});
    });

    it('leaves empty and blank DEBUG unchanged', () => {
        for (const value of ['', '  ']) {
            const env: NodeJS.ProcessEnv = { DEBUG: value };
            guardDebugNamespaces(env);
            expect(env.DEBUG).toBe(value);
        }
    });

    it('appends the follow-redirects skip to DEBUG=*', () => {
        const env: NodeJS.ProcessEnv = { DEBUG: '*' };
        guardDebugNamespaces(env);
        expect(env.DEBUG).toBe('*,-follow-redirects');
    });

    it('appends the follow-redirects skip after a matching namespace', () => {
        const env: NodeJS.ProcessEnv = { DEBUG: 'axios,follow-redirects' };
        guardDebugNamespaces(env);
        expect(env.DEBUG).toBe('axios,follow-redirects,-follow-redirects');
    });

    it('is idempotent when the skip is already present', () => {
        const env: NodeJS.ProcessEnv = { DEBUG: '*,-follow-redirects' };
        guardDebugNamespaces(env);
        expect(env.DEBUG).toBe('*,-follow-redirects');
    });

    it('leaves a space-separated DEBUG carrying the skip unchanged', () => {
        const env: NodeJS.ProcessEnv = { DEBUG: 'express:* -follow-redirects' };
        guardDebugNamespaces(env);
        expect(env.DEBUG).toBe('express:* -follow-redirects');
    });
});

describe('nodeDebugNetworkSection', () => {
    it('returns null for undefined and empty values', () => {
        expect(nodeDebugNetworkSection(undefined)).toBeNull();
        expect(nodeDebugNetworkSection('')).toBeNull();
    });

    it('matches the plain lowercase section names', () => {
        expect(nodeDebugNetworkSection('http')).toBe('http');
        expect(nodeDebugNetworkSection('HTTP')).toBe('http');
        expect(nodeDebugNetworkSection('https')).toBe('https');
        expect(nodeDebugNetworkSection('http2')).toBe('http2');
        expect(nodeDebugNetworkSection('tls')).toBe('tls');
    });

    it('matches lists and wildcards the way Node does', () => {
        expect(nodeDebugNetworkSection('fs,net')).toBe('net');
        expect(nodeDebugNetworkSection('*')).toBe('http');
        expect(nodeDebugNetworkSection('ht*')).toBe('http');
        expect(nodeDebugNetworkSection('n*t')).toBe('net');
    });

    it('returns null for non-network sections and untrimmed values', () => {
        expect(nodeDebugNetworkSection('module')).toBeNull();
        expect(nodeDebugNetworkSection('httpx')).toBeNull();
        expect(nodeDebugNetworkSection('fs,module')).toBeNull();
        expect(nodeDebugNetworkSection(' http')).toBeNull();
    });
});
