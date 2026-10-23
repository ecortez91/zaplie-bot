import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// Teams, Slack and other chat apps build a link preview from these tags when
// someone shares a portal URL. Guards against a return to the
// create-react-app defaults ("React App", "Web site created using
// create-react-app", no image).
const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8',
);
const doc = new DOMParser().parseFromString(html, 'text/html');

const meta = (selector: string): string | null =>
  doc.querySelector(selector)?.getAttribute('content') ?? null;

describe('public/index.html link preview metadata', () => {
  test('the title is Zaplie, not the create-react-app default', () => {
    expect(doc.title).toBe('Zaplie');
  });

  test('the description is set and is not the create-react-app default', () => {
    const description = meta('meta[name="description"]');
    expect(description).toMatch(/Zaplie/);
    expect(description).not.toMatch(/create-react-app/i);
  });

  test('Open Graph title, description and type are set', () => {
    expect(meta('meta[property="og:title"]')).toMatch(/Zaplie/);
    expect(meta('meta[property="og:description"]')).toMatch(/\S/);
    expect(meta('meta[property="og:type"]')).toBe('website');
  });

  test('the preview image is an absolute https URL with its size', () => {
    // Crawlers fetch og:image on their own, so a relative path or
    // %PUBLIC_URL% would break on the several hosts the portal runs at.
    for (const selector of [
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
    ]) {
      const image = meta(selector);
      expect(image).not.toBeNull();
      expect(new URL(image as string).protocol).toBe('https:');
    }
    expect(meta('meta[property="og:image:width"]')).toBe('1280');
    expect(meta('meta[property="og:image:height"]')).toBe('640');
    expect(meta('meta[name="twitter:card"]')).toBe('summary_large_image');
  });

  test('there is no host-specific og:url', () => {
    expect(doc.querySelector('meta[property="og:url"]')).toBeNull();
  });
});
