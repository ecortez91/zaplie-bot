import {
  FunctionComponent,
  useEffect,
  useState,
  useRef,
  useContext,
  useCallback,
} from 'react';
import styles from './UserListComponent.module.css';
import { getUsers } from '../services/lnbits/users';
import { getUserWallets } from '../services/lnbits/wallets';
import { useCache } from '../utils/CacheContext';
import { RewardNameContext } from './RewardNameContext';

// The wallet lookup is one request per user. Browsers cap concurrent requests
// per host, so an unbounded fan-out leaves the surplus queued in the browser
// while the gateway client's 30s timeout runs down against the queued request
// rather than the server — late users then render with blank wallet columns.
export const WALLET_FETCH_CONCURRENCY = 5;

const mapWithConcurrency = async <TIn, TOut>(
  items: TIn[],
  limit: number,
  worker: (item: TIn) => Promise<TOut>,
): Promise<TOut[]> => {
  const results = new Array<TOut>(items.length);
  let next = 0;

  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runner()),
  );

  return results;
};

const UserListComponent: FunctionComponent = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const fetchCalled = useRef(false); // Ref to track if fetchUsers has been called
  const { cache, setCache } = useCache();

  const fetchUsers = useCallback(async () => {
    //Load users from Cache or parameter
    setLoading(true);
    setError(null);

    try {
      const cachedUsers = cache['allUsers'] as User[] | undefined;
      let allUsers: User[];

      // An empty cached directory is treated as a cold cache, matching
      // SendZapsPopup: a stale empty entry must not render an empty table.
      if (Array.isArray(cachedUsers) && cachedUsers.length > 0) {
        allUsers = cachedUsers;
      } else {
        allUsers = await getUsers();
        setCache('allUsers', allUsers);
      }

      // Fetch wallets for each user, a bounded number of requests at a time
      const usersWithWallets = await mapWithConcurrency(
        allUsers,
        WALLET_FETCH_CONCURRENCY,
        async user => {
          try {
            const wallets = await getUserWallets(user.id);

            if (wallets && wallets.length > 0) {
              const privateWallet = wallets.find(w =>
                w.name.toLowerCase().includes('private'),
              );
              const allowanceWallet = wallets.find(w =>
                w.name.toLowerCase().includes('allowance'),
              );

              return {
                ...user,
                privateWallet: privateWallet || null,
                allowanceWallet: allowanceWallet || null,
              };
            }

            return user;
          } catch (err) {
            console.error(
              `[UserList] Error fetching wallets for user ${user.displayName}:`,
              err,
            );
            return user;
          }
        },
      );

      setUsers(usersWithWallets);
    } catch (err) {
      console.error('[UserList] Error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [cache, setCache]);

  useEffect(() => {
    if (!fetchCalled.current) {
      fetchCalled.current = true;
      fetchUsers();
    }
  }, [fetchUsers]);
  const rewardNameContext = useContext(RewardNameContext);
  if (!rewardNameContext) {
    return null; // or handle the case where the context is not available
  }
  const rewardsName = rewardNameContext.rewardNameLabel;
  if (loading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>{error}</div>;
  }

  return (
    <div className={styles.userslist}>
      <b className={styles.users}>Users</b>
      <div className={styles.tabs}>
        <div className={styles.tab}>
          <div className={styles.base}>
            <div className={styles.stringBadgeIconStack}>
              <b className={styles.stringTabTitle}>All</b>
            </div>
            <div className={styles.borderPaddingStack}>
              <div className={styles.borderBottom} />
            </div>
          </div>
        </div>
        <div className={styles.tab} style={{ display: 'none' }}>
          <div className={styles.base1}>
            <div className={styles.stringBadgeIconStack}>
              <div className={styles.stringTabTitle}>Teammates</div>
            </div>
          </div>
        </div>
        <div className={styles.tab} style={{ display: 'none' }}>
          <div className={styles.base1}>
            <div className={styles.stringBadgeIconStack}>
              <div className={styles.stringTabTitle}>Copilots</div>
            </div>
          </div>
        </div>
      </div>
      <div className={styles.list}>
        <div className={styles.headercell}>
          <div className={styles.headerContents}>
            <div className={styles.stringParent}>
              <b className={styles.string}>User</b>
              <b className={styles.string1}>User type</b>
              <b className={styles.string2}>Balance</b>
              <b className={styles.string3}>Allowance remaining</b>
            </div>
          </div>
        </div>
        {users
          ?.sort((a, b) => a.displayName.localeCompare(b.displayName))
          .map(user => (
            <div key={user.id} className={styles.bodycell}>
              <div className={styles.bodyContents}>
                <div className={styles.mainContentStack}>
                  <div className={styles.personDetails}>
                    <img
                      className={styles.avatarIcon}
                      alt=""
                      src={user.profileImg ? user.profileImg : 'profile.png'}
                    />
                    <div className={styles.userName}>
                      {/* Show displayName if it's not a UUID-like ID, otherwise show email or 'Unknown' */}
                      {user.displayName &&
                      !user.displayName.match(/^[a-f0-9]{32}$/)
                        ? user.displayName
                        : user.email || 'Unknown'}
                    </div>
                  </div>
                  <div className={styles.totalBalance}>
                    {user.type ? user.type : 'Teammate'}
                  </div>
                  <b className={styles.totalBalance1}>
                    {user.privateWallet
                      ? `${Math.floor(
                          user.privateWallet.balance_msat / 1000,
                        )} ${rewardsName}`
                      : 'N/A'}
                  </b>
                  <b className={styles.totalBalance2}>
                    {user.allowanceWallet
                      ? `${Math.floor(
                          user.allowanceWallet.balance_msat / 1000,
                        )} ${rewardsName}`
                      : 'N/A'}
                  </b>
                </div>
                <div className={styles.actions} />
              </div>
            </div>
          ))}
      </div>
      <div className={styles.poweredby}>
        <div className={styles.poweredBy}>
          <b className={styles.poweredBy1}>Powered by</b>
          <img className={styles.logo1Icon} alt="" src="LNbits.png" />
        </div>
      </div>
    </div>
  );
};

export default UserListComponent;
