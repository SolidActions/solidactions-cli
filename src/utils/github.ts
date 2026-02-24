import axios from 'axios';

export async function fetchRawFile(owner: string, repo: string, path: string, branch: string = 'main'): Promise<string> {
    try {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
        const response = await axios.get(url, { responseType: 'text' });
        return response.data;
    } catch (error: any) {
        if (error.response?.status === 404) {
            throw new Error(`File not found: ${owner}/${repo}/${path} (branch: ${branch})`);
        }
        throw new Error(`Failed to fetch ${owner}/${repo}/${path}: ${error.message}`);
    }
}

export async function listRepoContents(
    owner: string,
    repo: string,
    path: string = '',
    branch: string = 'main'
): Promise<{ name: string; type: string; download_url: string | null }[]> {
    try {
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
        const response = await axios.get(url);
        return response.data.map((item: any) => ({
            name: item.name,
            type: item.type,
            download_url: item.download_url,
        }));
    } catch (error: any) {
        if (error.response?.status === 403) {
            throw new Error('GitHub API rate limit reached (60 requests/hour for unauthenticated access). Please wait a few minutes and try again.');
        }
        if (error.response?.status === 404) {
            throw new Error(`Repository or path not found: ${owner}/${repo}/${path}`);
        }
        throw new Error(`Failed to list ${owner}/${repo}/${path}: ${error.message}`);
    }
}
