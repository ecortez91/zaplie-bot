// How long to wait for a Teams host to answer getContext. The host has
// already answered initialize over the same channel, so a reply normally
// takes milliseconds, but teams-js puts no timeout on getContext itself.
// MSAL's own ssoSilent timeout is 10 s.
export const TEAMS_CONTEXT_TIMEOUT_MS = 5000;

export const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
