import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { useLocation } from 'react-router-dom';
import { PageLayout } from './PageLayout';

// Signed out: the header and footer are not rendered, which is the state the
// sign-in page is seen in.
jest.mock('@azure/msal-react', () => ({
  AuthenticatedTemplate: () => null,
}));

// react-router-dom v7's ESM entry does not resolve under CRA's Jest config;
// the layout only reads the current location.
jest.mock('react-router-dom', () => ({
  useLocation: require('@jest/globals').jest.fn(),
}));

jest.mock('./HeaderComponent', () => () => null);
jest.mock('./FooterComponent', () => () => null);

const mockUseLocation = jest.mocked(useLocation);

describe('PageLayout', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  const mountAt = (pathname: string) => {
    mockUseLocation.mockReturnValue({
      pathname,
      search: '',
      hash: '',
      state: null,
      key: 'default',
    } as ReturnType<typeof useLocation>);
    root.render(
      <PageLayout>
        <p data-testid="page">page</p>
      </PageLayout>,
    );
  };

  const contentClassAt = async (pathname: string) => {
    await act(async () => {
      mountAt(pathname);
    });
    return container.querySelector('[data-testid="page"]')?.parentElement
      ?.className;
  };

  test.each(['/login', '/login/', '/Login'])(
    'lets the sign-in page (%s) fill the width instead of the content column',
    async pathname => {
      expect(await contentClassAt(pathname)).toBe('fullBleed');
    },
  );

  test.each(['/feed', '/login-help', '/settings/login'])(
    'keeps other pages (%s) in the content column',
    async pathname => {
      expect(await contentClassAt(pathname)).toBe('contentWrap');
    },
  );
});
