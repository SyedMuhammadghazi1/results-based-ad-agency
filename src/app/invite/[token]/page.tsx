import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Logo } from "@/components/site-chrome";
import type { ActionState } from "@/lib/action-state";
import { actionError } from "@/server/actions";
import { getSessionUser } from "@/server/guards";
import { acceptInvitation, findInvitation } from "@/server/orgs";

export const metadata = { title: "Invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await findInvitation(token);
  const user = await getSessionUser();

  async function accept(_prev: ActionState): Promise<ActionState> {
    "use server";
    try {
      const u = await getSessionUser();
      if (!u) return { ok: false, message: "Sign in first." };
      await acceptInvitation(token, u);
    } catch (err) {
      return actionError(err, "invite.accept");
    }
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-12">
      <Logo />
      <main id="main" className="card mt-8 w-full max-w-md space-y-4">
        {!invitation ? (
          <>
            <h1 className="text-xl font-semibold">Invitation not found</h1>
            <p className="text-sm text-ink-2">
              This invitation is invalid, already used or expired. Ask for a new one.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">Join {invitation.orgName}</h1>
            <p className="text-sm text-ink-2">
              You were invited as <strong>{invitation.invitation.email}</strong>.
            </p>
            {user ? (
              <ActionForm action={accept} submitLabel="Accept invitation" />
            ) : (
              <div className="flex gap-3">
                <Link className="btn btn-primary" href={`/sign-up?next=/invite/${token}`}>
                  Create account
                </Link>
                <Link className="btn btn-secondary" href="/sign-in">
                  Sign in
                </Link>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
