import type { GitAction, GitRef, GraphPage } from "../../shared/types.js";
import type { ContextMenuItem, ContextTarget } from "../components/ContextMenu";
import type { FormDialogSpec } from "../components/Dialog";
import { validateRefName } from "./refname";
import { remoteBranchName } from "./refs";

export interface MenuContext {
  page: GraphPage | undefined;
  /** An action is running: every mutating item is disabled. */
  busy: boolean;
  /** Parent count of a loaded commit (merge commits get a note). */
  parentCount: (hash: string) => number;
  subjectOf: (hash: string) => string | undefined;
  perform: (action: GitAction, label: string) => void;
  openForm: (spec: FormDialogSpec) => void;
  copy: (text: string, what: string) => void;
}

const short = (hash: string) => hash.slice(0, 7);

export function remoteNames(refs: readonly GitRef[]): string[] {
  const names = new Set<string>();
  for (const ref of refs) if (ref.kind === "remote") names.add(ref.name.slice(0, ref.name.indexOf("/")));
  return [...names].sort();
}

const code = (text: string) => <code>{text}</code>;

/* ---------------------------------------------- shared dialog builders */

/** Push dialog for a local branch (also used by the toolbar button). */
export function pushDialog(ctx: MenuContext, branch: string, upstream?: string): FormDialogSpec | undefined {
  const remotes = remoteNames(ctx.page?.refs ?? []);
  if (remotes.length === 0) return undefined;
  const upstreamRemote = upstream?.slice(0, upstream.indexOf("/"));
  return {
    title: `Push ${branch}`,
    confirmLabel: "Push",
    fields: [
      { kind: "select", name: "remote", label: "Remote", options: remotes.map((r) => ({ value: r, label: r })), initial: upstreamRemote && remotes.includes(upstreamRemote) ? upstreamRemote : remotes.includes("origin") ? "origin" : remotes[0] },
      { kind: "checkbox", name: "setUpstream", label: "Set as upstream branch (-u)", initial: !upstream },
      { kind: "checkbox", name: "force", label: "Force push (--force-with-lease)", hint: "overwrites remote history" },
    ],
    danger: (v) => v.force === true,
    description: (v) =>
      v.force ? (
        <>
          Force-push {code(branch)} to {code(`${String(v.remote)}/${branch}`)} using <code>--force-with-lease</code>. Remote commits that are not in your branch will be{" "}
          <strong>overwritten</strong> (refused only if the remote moved since your last fetch).
        </>
      ) : (
        <>
          Push {code(branch)} to {code(`${String(v.remote)}/${branch}`)}.
        </>
      ),
    onConfirm: (v) =>
      ctx.perform(
        { type: "push", branch, remote: String(v.remote), setUpstream: v.setUpstream === true, force: v.force === true ? "with-lease" : "none" },
        `Push ${branch}`,
      ),
  };
}

export function pullDialog(ctx: MenuContext, branch: string): FormDialogSpec {
  return {
    title: `Pull into ${branch}`,
    confirmLabel: "Pull",
    fields: [
      {
        kind: "radio",
        name: "mode",
        label: "Integrate remote changes by",
        initial: "merge",
        options: [
          { value: "merge", label: "Merge", hint: "(git pull --no-rebase; fast-forwards when possible)" },
          { value: "rebase", label: "Rebase", hint: "(git pull --rebase; rewrites your local commits)" },
        ],
      },
    ],
    danger: (v) => v.mode === "rebase",
    description: (v) =>
      v.mode === "rebase" ? (
        <>
          Fetch the upstream of {code(branch)} and <strong>rebase</strong> your unpushed local commits on top of it. Those commits get new hashes.
        </>
      ) : (
        <>Fetch the upstream of {code(branch)} and merge it into {code(branch)}.</>
      ),
    onConfirm: (v) => ctx.perform({ type: "pull", rebase: v.mode === "rebase" }, `Pull ${branch}`),
  };
}

function createBranchDialog(ctx: MenuContext, startPoint: string, startLabel: string): FormDialogSpec {
  return {
    title: "Create branch",
    description: <>New branch starting at {code(startLabel)}.</>,
    confirmLabel: "Create",
    fields: [
      { kind: "text", name: "name", label: "Branch name", placeholder: "feature/my-branch", validate: (v) => validateRefName(v, "branch") },
      { kind: "checkbox", name: "checkout", label: "Check out after creating", initial: true },
    ],
    onConfirm: (v) =>
      ctx.perform({ type: "createBranch", name: String(v.name), startPoint, checkout: v.checkout === true }, `Create branch ${String(v.name)}`),
  };
}

function mergeDialog(ctx: MenuContext, ref: string, label: string, current: string): FormDialogSpec {
  return {
    title: "Merge",
    confirmLabel: "Merge",
    fields: [
      { kind: "checkbox", name: "noFastForward", label: "Always create a merge commit (--no-ff)" },
      { kind: "checkbox", name: "squash", label: "Squash commits (--squash)", hint: "stages the changes without committing" },
    ],
    description: (v) => (
      <>
        Merge {code(label)} into the current branch {code(current)}
        {v.squash ? ", staging all its changes as a single uncommitted change (no merge commit)." : v.noFastForward ? ", always creating a merge commit." : ", fast-forwarding when possible."}
      </>
    ),
    onConfirm: (v) => ctx.perform({ type: "merge", ref, noFastForward: v.noFastForward === true, squash: v.squash === true }, `Merge ${label}`),
  };
}

function rebaseDialog(ctx: MenuContext, onto: string, label: string, current: string): FormDialogSpec {
  return {
    title: "Rebase",
    confirmLabel: "Rebase",
    danger: true,
    description: (
      <>
        Rebase the current branch {code(current)} onto {code(label)}. Its commits that are not in {code(label)} are replayed on top and get <strong>new hashes</strong>
        {" "}(history rewrite). If it was already pushed, a force push will be needed.
      </>
    ),
    onConfirm: () => ctx.perform({ type: "rebase", onto }, `Rebase ${current} onto ${label}`),
  };
}

function tagPushDialog(ctx: MenuContext, name: string): FormDialogSpec | undefined {
  const remotes = remoteNames(ctx.page?.refs ?? []);
  if (remotes.length === 0) return undefined;
  return {
    title: `Push tag ${name}`,
    confirmLabel: "Push tag",
    fields: [{ kind: "select", name: "remote", label: "Remote", options: remotes.map((r) => ({ value: r, label: r })), initial: remotes.includes("origin") ? "origin" : remotes[0] }],
    description: (v) => <>Push tag {code(name)} to remote {code(String(v.remote))}.</>,
    onConfirm: (v) => ctx.perform({ type: "pushTag", remote: String(v.remote), name }, `Push tag ${name}`),
  };
}

function deleteRemoteBranchDialog(ctx: MenuContext, remoteRef: string): FormDialogSpec {
  const remote = remoteRef.slice(0, remoteRef.indexOf("/"));
  const name = remoteBranchName(remoteRef);
  return {
    title: "Delete remote branch",
    confirmLabel: "Delete remote branch",
    danger: true,
    description: (
      <>
        Run <code>git push {remote} --delete {name}</code>: the branch {code(name)} will be <strong>deleted on the remote {remote}</strong> for everyone. This cannot be undone from here.
      </>
    ),
    onConfirm: () => ctx.perform({ type: "deleteRemoteBranch", remote, name }, `Delete ${remoteRef}`),
  };
}

/* ------------------------------------------------------------ menus */

export function buildMenuItems(target: ContextTarget, ctx: MenuContext): ContextMenuItem[] {
  const page = ctx.page;
  const head = page?.head;
  const current = head?.branch;
  const currentLabel = current ?? "HEAD";
  const blockedReason = !page ? "Not loaded" : ctx.busy ? "Another action is running" : page.operation ? `Finish or abort the ${page.operation} in progress first` : undefined;
  const hasRemotes = remoteNames(page?.refs ?? []).length > 0;

  /** Mutating item: disabled while busy or an operation is in progress. */
  const act = (id: string, label: string, onSelect: () => void, extra: Partial<ContextMenuItem> & { reason?: string } = {}): ContextMenuItem => {
    const { reason, ...rest } = extra;
    const disabledReason = blockedReason ?? reason;
    return { id, label, onSelect, disabled: !!disabledReason, title: disabledReason, ...rest };
  };
  const copyItem = (id: string, label: string, text: string | undefined, what: string, separator = false): ContextMenuItem[] =>
    text === undefined ? [] : [{ id, label, separator, onSelect: () => ctx.copy(text, what) }];

  switch (target.kind) {
    case "commit": {
      const hash = target.hash;
      const isHead = head?.hash === hash;
      const subject = ctx.subjectOf(hash);
      const noHead = !head?.hash ? "No current commit" : undefined;
      const detached = head?.detached ? "HEAD is detached" : undefined;
      const items: ContextMenuItem[] = [
        act("tag", "Add Tag…", () =>
          ctx.openForm({
            title: "Add tag",
            description: <>Tag commit {code(short(hash))}.</>,
            confirmLabel: "Add tag",
            fields: [
              { kind: "text", name: "name", label: "Tag name", placeholder: "v1.0.0", validate: (v) => validateRefName(v, "tag") },
              { kind: "text", name: "message", label: "Message", hint: "Optional. A message creates an annotated tag." },
            ],
            onConfirm: (v) => ctx.perform({ type: "createTag", name: String(v.name), hash, message: String(v.message).trim() || undefined }, `Add tag ${String(v.name)}`),
          }),
        ),
        act("branch", "Create Branch…", () => ctx.openForm(createBranchDialog(ctx, hash, short(hash)))),
        act(
          "detach",
          "Checkout (detached)…",
          () =>
            ctx.openForm({
              title: "Checkout commit",
              description: <>Detach HEAD at commit {code(short(hash))}. You will not be on any branch; new commits are not kept unless you create a branch.</>,
              confirmLabel: "Checkout",
              onConfirm: () => ctx.perform({ type: "checkoutCommit", hash }, `Checkout ${short(hash)}`),
            }),
          { reason: isHead && head?.detached ? "Already checked out" : undefined },
        ),
        act(
          "cherry",
          "Cherry Pick…",
          () =>
            ctx.openForm({
              title: "Cherry-pick",
              description: (
                <>
                  Apply the changes of {code(short(hash))}
                  {subject ? ` “${subject}”` : ""} onto {code(currentLabel)}.
                  {ctx.parentCount(hash) > 1 && " This is a merge commit: changes relative to its first parent (-m 1) are applied."}
                </>
              ),
              confirmLabel: "Cherry-pick",
              fields: [{ kind: "checkbox", name: "noCommit", label: "Apply without committing (--no-commit)" }],
              onConfirm: (v) => ctx.perform({ type: "cherryPick", hash, noCommit: v.noCommit === true }, `Cherry-pick ${short(hash)}`),
            }),
          { reason: noHead ?? (isHead ? "This is the current commit" : undefined) },
        ),
        act("revert", "Revert…", () =>
          ctx.openForm({
            title: "Revert commit",
            description: (
              <>
                Create a new commit on {code(currentLabel)} that undoes {code(short(hash))}
                {subject ? ` “${subject}”` : ""}.
                {ctx.parentCount(hash) > 1 && " This is a merge commit: it is reverted relative to its first parent (-m 1)."}
              </>
            ),
            confirmLabel: "Revert",
            onConfirm: () => ctx.perform({ type: "revert", hash }, `Revert ${short(hash)}`),
          }),
          { reason: noHead },
        ),
        act("merge", "Merge into current branch…", () => ctx.openForm(mergeDialog(ctx, hash, short(hash), currentLabel)), {
          separator: true,
          reason: noHead ?? (isHead ? "This is the current commit" : undefined),
        }),
        act("rebase", "Rebase current branch on this commit…", () => ctx.openForm(rebaseDialog(ctx, hash, short(hash), currentLabel)), {
          reason: noHead ?? detached ?? (isHead ? "This is the current commit" : undefined),
        }),
        act(
          "reset",
          "Reset current branch to this commit…",
          () =>
            ctx.openForm({
              title: "Reset current branch",
              confirmLabel: "Reset",
              danger: true,
              fields: [
                {
                  kind: "radio",
                  name: "mode",
                  label: "Mode",
                  initial: "mixed",
                  options: [
                    { value: "soft", label: "Soft", hint: "keep index and working tree" },
                    { value: "mixed", label: "Mixed", hint: "keep working tree, reset index" },
                    { value: "hard", label: "Hard", hint: "discard all uncommitted changes" },
                  ],
                },
              ],
              description: (v) => (
                <>
                  Move {code(currentLabel)} to {code(short(hash))} (<code>git reset --{String(v.mode)}</code>). Commits after it stop being on the branch.
                  {v.mode === "hard" && (
                    <>
                      {" "}
                      <strong>All uncommitted changes in tracked files will be permanently lost.</strong>
                    </>
                  )}
                </>
              ),
              onConfirm: (v) => ctx.perform({ type: "reset", hash, mode: v.mode as "soft" | "mixed" | "hard" }, `Reset ${currentLabel} (${String(v.mode)}) to ${short(hash)}`),
            }),
          { reason: noHead ?? (isHead ? "This is the current commit" : undefined) },
        ),
        ...copyItem("copy-hash", "Copy hash", hash, "hash", true),
        ...copyItem("copy-subject", "Copy subject", subject, "subject"),
      ];
      return items;
    }

    case "uncommitted": {
      const wt = page?.workingTree;
      return [
        act("stash", "Stash changes…", () =>
          ctx.openForm({
            title: "Stash changes",
            description: <>Save your uncommitted changes to a new stash and restore a clean working tree.</>,
            confirmLabel: "Stash",
            fields: [
              { kind: "text", name: "message", label: "Message", hint: "Optional" },
              { kind: "checkbox", name: "includeUntracked", label: "Include untracked files (-u)", initial: (wt?.untracked ?? 0) > 0 },
            ],
            onConfirm: (v) => ctx.perform({ type: "stashPush", message: String(v.message).trim() || undefined, includeUntracked: v.includeUntracked === true }, "Stash changes"),
          }),
        ),
        act(
          "discard",
          "Discard all changes…",
          () =>
            ctx.openForm({
              title: "Discard all changes",
              danger: true,
              confirmLabel: "Discard all changes",
              description: (
                <>
                  Run <code>git reset --hard HEAD</code>: <strong>all staged and unstaged changes to tracked files will be permanently lost</strong> and cannot be recovered. Untracked files are not touched.
                </>
              ),
              onConfirm: () => ctx.perform({ type: "reset", hash: head!.hash!, mode: "hard" }, "Discard all changes"),
            }),
          { danger: true, reason: head?.hash ? undefined : "No commit yet" },
        ),
      ];
    }

    case "ref": {
      const badge = target.badge;
      switch (badge.kind) {
        case "branch": {
          const name = badge.name;
          const isHead = badge.isHead;
          const items: ContextMenuItem[] = [
            act("checkout", "Checkout", () => ctx.perform({ type: "checkout", ref: name }, `Checkout ${name}`), { reason: isHead ? "Already checked out" : undefined }),
            act("rename", "Rename…", () =>
              ctx.openForm({
                title: "Rename branch",
                description: <>Rename local branch {code(name)}.</>,
                confirmLabel: "Rename",
                fields: [{ kind: "text", name: "newName", label: "New name", initial: name, validate: (v) => (v === name ? "Enter a different name." : validateRefName(v, "branch")) }],
                onConfirm: (v) => ctx.perform({ type: "renameBranch", oldName: name, newName: String(v.newName) }, `Rename ${name}`),
              }),
            ),
            act(
              "delete",
              "Delete…",
              () =>
                ctx.openForm({
                  title: "Delete branch",
                  danger: true,
                  confirmLabel: "Delete branch",
                  fields: [{ kind: "checkbox", name: "force", label: "Force delete (-D)", hint: "even if not fully merged" }],
                  description: (v) => (
                    <>
                      Delete the local branch {code(name)} (<code>git branch {v.force ? "-D" : "-d"} {name}</code>).{" "}
                      {v.force ? (
                        <strong>Commits that are only reachable from this branch will be lost.</strong>
                      ) : (
                        "Git refuses if it has commits not merged into HEAD or its upstream."
                      )}{" "}
                      Remote branches are not affected.
                    </>
                  ),
                  onConfirm: (v) => ctx.perform({ type: "deleteBranch", name, force: v.force === true }, `Delete branch ${name}`),
                }),
              { danger: true, reason: isHead ? "Cannot delete the checked-out branch" : undefined },
            ),
            act("merge", "Merge into current branch…", () => ctx.openForm(mergeDialog(ctx, name, name, currentLabel)), {
              separator: true,
              reason: isHead ? "This is the current branch" : !head?.hash ? "No current commit" : undefined,
            }),
            act("rebase", `Rebase current branch on ${name}…`, () => ctx.openForm(rebaseDialog(ctx, name, name, currentLabel)), {
              reason: isHead ? "This is the current branch" : head?.detached ? "HEAD is detached" : !head?.hash ? "No current commit" : undefined,
            }),
            act(
              "push",
              "Push…",
              () => {
                const spec = pushDialog(ctx, name, badge.upstream);
                if (spec) ctx.openForm(spec);
              },
              { separator: true, reason: hasRemotes ? undefined : "No remote configured" },
            ),
            act("branch-from", "Create branch from…", () => ctx.openForm(createBranchDialog(ctx, name, name))),
          ];
          for (const remote of badge.remotes) {
            items.push(act(`delete-remote-${remote}`, `Delete remote branch ${remote}…`, () => ctx.openForm(deleteRemoteBranchDialog(ctx, remote)), { danger: true }));
          }
          return [...items, ...copyItem("copy-name", "Copy name", name, "name", true)];
        }

        case "remote": {
          const name = badge.name;
          const remote = name.slice(0, name.indexOf("/"));
          return [
            act("checkout", "Checkout (create tracking branch)", () => ctx.perform({ type: "checkout", ref: name }, `Checkout ${name}`)),
            act("delete-remote", "Delete remote branch…", () => ctx.openForm(deleteRemoteBranchDialog(ctx, name)), { danger: true }),
            act("fetch", `Fetch ${remote}`, () => ctx.perform({ type: "fetch", remote, prune: false }, `Fetch ${remote}`), { separator: true }),
            act("merge", "Merge into current branch…", () => ctx.openForm(mergeDialog(ctx, name, name, currentLabel)), { reason: head?.hash ? undefined : "No current commit" }),
            ...copyItem("copy-name", "Copy name", name, "name", true),
          ];
        }

        case "tag": {
          const name = badge.name;
          return [
            act("delete-tag", "Delete tag…", () =>
              ctx.openForm({
                title: "Delete tag",
                danger: true,
                confirmLabel: "Delete tag",
                description: (
                  <>
                    Delete the local tag {code(name)}. If it was pushed, it stays on the remote.
                  </>
                ),
                onConfirm: () => ctx.perform({ type: "deleteTag", name }, `Delete tag ${name}`),
              }),
              { danger: true },
            ),
            act(
              "push-tag",
              "Push tag…",
              () => {
                const spec = tagPushDialog(ctx, name);
                if (spec) ctx.openForm(spec);
              },
              { reason: hasRemotes ? undefined : "No remote configured" },
            ),
            ...copyItem("copy-name", "Copy name", name, "name", true),
          ];
        }

        case "stash": {
          const name = badge.name;
          return [
            act("apply", "Apply", () => ctx.perform({ type: "stashApply", name }, `Apply ${name}`)),
            act("pop", "Pop", () => ctx.perform({ type: "stashPop", name }, `Pop ${name}`)),
            act("drop", "Drop…", () =>
              ctx.openForm({
                title: "Drop stash",
                danger: true,
                confirmLabel: "Drop stash",
                description: (
                  <>
                    Permanently delete {code(name)} and the changes it holds. This cannot be undone.
                  </>
                ),
                onConfirm: () => ctx.perform({ type: "stashDrop", name }, `Drop ${name}`),
              }),
              { danger: true },
            ),
            act("stash-branch", "Create branch from stash…", () =>
              ctx.openForm({
                title: "Create branch from stash",
                description: <>Create a branch from the commit {code(name)} was made on, check it out, apply the stash and drop it.</>,
                confirmLabel: "Create branch",
                fields: [{ kind: "text", name: "branch", label: "Branch name", validate: (v) => validateRefName(v, "branch") }],
                onConfirm: (v) => ctx.perform({ type: "stashBranch", name, branch: String(v.branch) }, `Branch ${String(v.branch)} from ${name}`),
              }),
            ),
            ...copyItem("copy-name", "Copy name", name, "name", true),
          ];
        }
      }
    }
  }
}
