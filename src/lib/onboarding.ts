/** Client onboarding progress (pure). */

export type OnboardingFacts = {
  hasOrg: boolean;
  hasIntake: boolean;
  hasAgreement: boolean;
  trackingSeen: boolean;
  revenueSourceConnected: boolean;
  paymentMethodReady: boolean;
};

export const ONBOARDING_STEPS = [
  { id: "organization", label: "Organization", href: "/onboarding/organization" },
  { id: "intake", label: "Business details", href: "/onboarding/intake" },
  { id: "agreement", label: "Performance agreement", href: "/onboarding/agreement" },
  { id: "tracking", label: "Tracking & revenue source", href: "/onboarding/tracking" },
  { id: "payment", label: "Payment method", href: "/onboarding/payment" },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];

export function onboardingProgress(f: OnboardingFacts) {
  const done: Record<OnboardingStepId, boolean> = {
    organization: f.hasOrg,
    intake: f.hasIntake,
    agreement: f.hasAgreement,
    tracking: f.trackingSeen && f.revenueSourceConnected,
    payment: f.paymentMethodReady,
  };
  const steps = ONBOARDING_STEPS.map((s) => ({ ...s, done: done[s.id] }));
  const next = steps.find((s) => !s.done) ?? null;
  return {
    steps,
    next,
    complete: next === null,
    /** The dashboard unlocks once the agreement is accepted. */
    dashboardUnlocked: f.hasOrg && f.hasIntake && f.hasAgreement,
    /** Campaigns may only go live when everything is in place. */
    readyToLaunch: steps.every((s) => s.done),
  };
}

/** A step is reachable only when every earlier required step is done. */
export function canAccessStep(step: OnboardingStepId, f: OnboardingFacts): boolean {
  switch (step) {
    case "organization":
      return true;
    case "intake":
      return f.hasOrg;
    case "agreement":
      return f.hasOrg && f.hasIntake;
    case "tracking":
    case "payment":
      return f.hasOrg && f.hasIntake && f.hasAgreement;
  }
}
