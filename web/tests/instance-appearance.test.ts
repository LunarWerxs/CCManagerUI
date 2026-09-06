// web/tests/instance-appearance.test.ts — what an instance is CALLED (web/src/lib/instance-appearance.ts).
//
// The precedence is the whole point and it is load-bearing: an explicit label the user typed beats
// everything, then the account the profile is actually signed into, and only then the folder name.
// The folder is last because it is the one that lies — the machine this was built against had a
// folder named `claude` signed into 6claude@lunarwerx.com, and two folders (3claude/4claude) whose
// accounts were the other way round. Nothing detects that drift, so the folder cannot be trusted
// ahead of a resolved identity.
//
// displayName() takes Pick<CMInstance, 'name' | 'label' | 'account'>, so instances are built by hand
// here rather than going through the API — these are pure functions over three fields.

import { describe, expect, test } from 'bun:test'
import type { CMAccount } from '../../server/src/core/shared'
import {
  accountDisplayName,
  accountEmail,
  accountName,
  displayName,
  instanceForSessionLabel,
  labelDisagreesWithAccount,
  loginChanged,
} from '../src/lib/instance-appearance'

/** A CMAccount is 12 fields and these functions read exactly two — build from a base so each test
 *  states only the field it is actually about. */
function account(patch: Partial<CMAccount> = {}): CMAccount {
  return {
    status: 'live',
    email: null,
    name: null,
    plan: null,
    rateLimitTier: null,
    orgType: null,
    planLabel: null,
    accountUuid: null,
    orgUuid: null,
    orgName: null,
    source: 'live',
    label: '(unknown account)',
    ...patch,
  }
}

/** The logged-out shape resolveAccount() really returns: a non-empty label, but no identity behind
 *  it (server/src/core/accounts.ts). The label must NOT become a name. */
const LOGGED_OUT = account({ status: 'loggedout', label: '(not logged in)' })

describe('accountName', () => {
  test('prefers the profile name', () => {
    expect(accountName(account({ name: 'LunarWerx', email: 'lunawerx@gmail.com' }))).toBe(
      'LunarWerx',
    )
  })

  test("falls back to the email's local part when there is no name", () => {
    expect(accountName(account({ email: '6claude@lunarwerx.com' }))).toBe('6claude')
  })

  test('is null for null/undefined, and for an account carrying no identity', () => {
    expect(accountName(null)).toBeNull()
    expect(accountName(undefined)).toBeNull()
    expect(accountName(account())).toBeNull()
    // Logged out resolves with a LABEL but no identity — the label is not a name.
    expect(accountName(LOGGED_OUT)).toBeNull()
  })

  test('treats a whitespace-only name as absent and moves on to the email', () => {
    expect(accountName(account({ name: '   ', email: '5claude@lunarwerx.com' }))).toBe('5claude')
  })

  test('is null when the email is whitespace-only or has no local part', () => {
    expect(accountName(account({ email: '   ' }))).toBeNull()
    expect(accountName(account({ email: '@lunarwerx.com' }))).toBeNull()
  })

  test('handles an email-shaped string with no @ by using the whole thing', () => {
    expect(accountName(account({ email: 'not-an-email' }))).toBe('not-an-email')
  })
})

describe('loginChanged', () => {
  const A = 'aaaa-1111'
  const B = 'bbbb-2222'

  test('is true when the instance is signed into a different account than the one shown', () => {
    expect(loginChanged({ loginUuid: B, account: account({ accountUuid: A }) })).toBe(true)
  })

  test('is false while the shown identity still matches the login', () => {
    expect(loginChanged({ loginUuid: A, account: account({ accountUuid: A }) })).toBe(false)
  })

  test('is false whenever either side is unknown', () => {
    // Nothing resolved yet — already being chased, so this must not also count as drift.
    expect(loginChanged({ loginUuid: A, account: null })).toBe(false)
    expect(loginChanged({ loginUuid: A, account: account({ accountUuid: null }) })).toBe(false)
    // Signed out (or an unreadable config.json): no uuid to disagree with.
    expect(loginChanged({ loginUuid: null, account: account({ accountUuid: A }) })).toBe(false)
    expect(loginChanged({ loginUuid: null, account: LOGGED_OUT })).toBe(false)
  })
})

describe('displayName', () => {
  test('an explicit label wins over both the account and the folder', () => {
    const name = displayName({
      name: '3claude',
      label: 'My Main',
      account: account({ name: '4claude', email: '4claude@lunarwerx.com' }),
    })
    expect(name).toBe('My Main')
  })

  test('the account beats the folder — the real 6claude-in-a-folder-called-claude case', () => {
    const name = displayName({
      name: 'claude',
      label: null,
      account: account({ email: '6claude@lunarwerx.com' }),
    })
    expect(name).toBe('6claude')
  })

  test('the folder name is the last resort, not the first choice', () => {
    expect(displayName({ name: 'work', label: null, account: null })).toBe('work')
    // Logged out is still "no identity" — fall through to the folder rather than showing a label
    // that reads "(not logged in)" as if it were the instance's name.
    expect(displayName({ name: 'work', label: null, account: LOGGED_OUT })).toBe('work')
  })

  test('a whitespace-only label does not shadow the account', () => {
    const name = displayName({
      name: 'folder',
      label: '   ',
      account: account({ name: 'LunarWerx' }),
    })
    expect(name).toBe('LunarWerx')
  })

  test('a label is trimmed rather than shown with its padding', () => {
    expect(displayName({ name: 'folder', label: '  Spaced  ', account: null })).toBe('Spaced')
  })

  test('two instances on one account share a name — the dir is what disambiguates them', () => {
    const shared = account({ name: '4claude', email: '4claude@lunarwerx.com' })
    expect(displayName({ name: 'a', label: null, account: shared })).toBe('4claude')
    expect(displayName({ name: 'b', label: null, account: shared })).toBe('4claude')
  })
})

// --- the address behind the handle ---------------------------------------------------------------
// accountHandle() is a DISPLAY compromise: it fits a table column, and it is not an identifier —
// `5claude@lunarwerx.com` and `5claude@gmail.com` render the same chip. So anything that leaves the
// app (a clipboard, a paste into another tool) must use the full address, and only the full one.
describe('accountEmail', () => {
  test('returns the full address, not the handle the column shows', () => {
    expect(accountEmail(account({ email: '5claude@lunarwerx.com' }))).toBe('5claude@lunarwerx.com')
  })

  test('trims, because a padded address is not a different address', () => {
    expect(accountEmail(account({ email: '  5claude@lunarwerx.com  ' }))).toBe(
      '5claude@lunarwerx.com',
    )
  })

  test('nothing resolved yet is null, never a guess', () => {
    expect(accountEmail(null)).toBeNull()
    expect(accountEmail(undefined)).toBeNull()
    expect(accountEmail(account({ email: null }))).toBeNull()
    expect(accountEmail(account({ email: '   ' }))).toBeNull()
  })

  test('a signed-out account has a label but no address — the label must not become one', () => {
    // '(not logged in)' on the clipboard, looking like an address, is the failure this guards.
    expect(accountEmail(LOGGED_OUT)).toBeNull()
  })
})

// --- joining a SESSION to the instance it ran in --------------------------------------------------
// A session carries an instance LABEL, and there are two kinds: an isolated instance's dir name,
// and the literal 'default' for the regular non-isolated Claude Desktop. Only the first matches
// CMInstance.name — the default install's row is named after its folder ("Claude" on Windows) and
// nothing is ever called "default" — which is why the server ships isDefault.
describe('instanceForSessionLabel', () => {
  const rows = [
    { name: 'Claude', isDefault: true },
    { name: '4claude', isDefault: false },
    { name: '5claude', isDefault: false },
  ]

  test('a dir-name label matches the instance of that name', () => {
    expect(instanceForSessionLabel(rows, '5claude')).toBe(rows[2])
  })

  test("'default' finds the non-isolated install, whose name is never 'default'", () => {
    expect(instanceForSessionLabel(rows, 'default')).toBe(rows[0])
  })

  test("'default' with the regular install not running resolves to nothing, not to a near-match", () => {
    // Its row only exists while a process for it does. Falling back to any other row here would put
    // one account's email against another account's chat — the exact thing loginChanged prevents.
    expect(instanceForSessionLabel([rows[1], rows[2]], 'default')).toBeNull()
  })

  test('an unknown label — a folder deleted since the chat ran — is null', () => {
    expect(instanceForSessionLabel(rows, 'deleted-instance')).toBeNull()
  })

  test('no label at all (a plain CLI or non-Claude transcript) is null', () => {
    expect(instanceForSessionLabel(rows, null)).toBeNull()
    expect(instanceForSessionLabel(rows, undefined)).toBeNull()
    expect(instanceForSessionLabel(rows, '')).toBeNull()
  })

  test('an empty instance list is null rather than a throw', () => {
    expect(instanceForSessionLabel([], '4claude')).toBeNull()
    expect(instanceForSessionLabel([], 'default')).toBeNull()
  })

  test('an isolated folder actually named "default" resolves to itself', () => {
    // Nothing stops a user creating one (validateInstanceName allows the word), and scanAll stamps
    // ITS chats with the string 'default' too. On its own it is the only candidate, so it wins —
    // the sentinel must not outrank the folder that really holds those chats.
    const onlyDecoy = [
      { name: 'default', isDefault: false },
      { name: '4claude', isDefault: false },
    ]
    expect(instanceForSessionLabel(onlyDecoy, 'default')).toBe(onlyDecoy[0])
  })

  test('the regular install AND a folder named "default" together resolve to NOTHING', () => {
    // Both stores stamp their chats 'default', so the server cannot say which one a chat came
    // from — and neither can this. Picking either would show one account's address on the other
    // account's conversation, which is the failure this whole lookup exists to avoid.
    const both = [{ name: 'default', isDefault: false }, ...rows]
    expect(instanceForSessionLabel(both, 'default')).toBeNull()
  })
})

// Ambiguity is "unknown", never "pick one" — the whole point of the lookup is that a wrong answer
// puts one account's address against another account's chat.
describe('instanceForSessionLabel — ambiguity', () => {
  test('two rows flagged as the regular install resolve to nothing', () => {
    const rows = [
      { name: 'Claude', isDefault: true },
      { name: 'Claude-2', isDefault: true },
    ]
    expect(instanceForSessionLabel(rows, 'default')).toBeNull()
  })

  test('two instances with the same folder name resolve to nothing', () => {
    // Reachable today: one row can come from the instances root and another from a running
    // process launched from a different root, and both are named by their basename.
    const rows = [
      { name: 'work', isDefault: false },
      { name: 'work', isDefault: false },
    ]
    expect(instanceForSessionLabel(rows, 'work')).toBeNull()
  })
})

// --- a typed name that no longer matches the account behind it ------------------------------------
// A label overrides everything and nothing ever re-checked one, so an instance signed into a
// different account keeps the old account's name for good. Observed on the owner's machine: the
// folder `4claude` was labelled "3claude" while `3claude` was labelled something else again, which
// makes the name column actively misleading rather than merely out of date. This predicate is what
// lets the row SAY so; it must not fire on the ordinary cases or the marker stops meaning anything.
describe('labelDisagreesWithAccount', () => {
  test('fires when the typed name is a different account entirely', () => {
    expect(
      labelDisagreesWithAccount({
        label: '3claude',
        account: account({ email: '4claude@lunarwerx.com' }),
      }),
    ).toBe(true)
  })

  test('does not fire when there is no typed name — nothing to disagree', () => {
    expect(labelDisagreesWithAccount({ label: null, account: account({ email: 'a@b.com' }) })).toBe(
      false,
    )
    expect(
      labelDisagreesWithAccount({ label: '   ', account: account({ email: 'a@b.com' }) }),
    ).toBe(false)
  })

  test('does not fire while the account is unresolved — unknown is not disagreement', () => {
    // Every row would light up for the second between load and resolve, which trains the marker
    // straight out of usefulness.
    expect(labelDisagreesWithAccount({ label: 'Toby', account: null })).toBe(false)
    expect(labelDisagreesWithAccount({ label: 'Toby', account: LOGGED_OUT })).toBe(false)
  })

  test('does not fire when the user simply typed the account name themselves', () => {
    // Agreement, not drift — in either of the two forms accountName can take.
    expect(
      labelDisagreesWithAccount({
        label: '4claude',
        account: account({ email: '4claude@lunarwerx.com' }),
      }),
    ).toBe(false)
    expect(
      labelDisagreesWithAccount({
        label: 'Michael Griswold',
        account: account({ name: 'Michael Griswold', email: 'mg@lunarwerx.com' }),
      }),
    ).toBe(false)
  })

  test('matches the email handle even when the profile carries a different display name', () => {
    // accountName prefers the profile name, so a label typed from the HANDLE would otherwise read
    // as a mismatch against a profile called something else. Both spellings are the same account.
    expect(
      labelDisagreesWithAccount({
        label: 'noviero',
        account: account({ name: 'Martin', email: 'noviero@gmail.com' }),
      }),
    ).toBe(false)
  })

  test('case and padding do not make a match into a mismatch', () => {
    expect(
      labelDisagreesWithAccount({
        label: '  5Claude  ',
        account: account({ email: '5claude@lunarwerx.com' }),
      }),
    ).toBe(false)
  })
})

// --- naming a row after the LOGIN, not the profile's display name ---------------------------------
// The Anthropic profile's full_name is whatever the person typed into claude.ai, so naming rows with
// it gave a table reading "Toby", "Martin", "Michael Griswold" — friendly words that do not say
// which login each row is and cannot be matched against the folder or the number. Observed: an
// instance in the folder `6claude`, signed into 6claude@…, displayed as "Toby". The handle is the
// one field every signed-in account has, is unique, and the user actually typed.
describe('accountDisplayName', () => {
  test('prefers the email handle over the profile display name', () => {
    expect(accountDisplayName(account({ name: 'Toby', email: '6claude@lunarwerx.com' }))).toBe(
      '6claude',
    )
  })

  test('falls back to the profile name when there is no address to take a handle from', () => {
    // Dropping to the folder name here would throw away the better answer we already have.
    expect(accountDisplayName(account({ name: 'Toby', email: null }))).toBe('Toby')
  })

  test('nothing resolved, or signed out, is null', () => {
    expect(accountDisplayName(null)).toBeNull()
    expect(accountDisplayName(account())).toBeNull()
    expect(accountDisplayName(LOGGED_OUT)).toBeNull()
  })
})

describe('displayName follows the login', () => {
  test('a profile called something else does not rename the row', () => {
    // The regression this pins: the row used to read "Toby" for the 6claude login.
    expect(
      displayName({
        name: '6claude',
        label: null,
        account: account({ name: 'Toby', email: '6claude@lunarwerx.com' }),
      }),
    ).toBe('6claude')
  })

  test('a label the user typed still wins over the account', () => {
    // Unchanged and deliberate: the override is theirs. labelDisagreesWithAccount is what surfaces
    // one that has gone stale; it is not this function's job to overrule it.
    expect(
      displayName({
        name: '6claude',
        label: 'Build box',
        account: account({ name: 'Toby', email: '6claude@lunarwerx.com' }),
      }),
    ).toBe('Build box')
  })
})
