import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { Field, Select, TextArea } from "@/components/field";
import { submitApplication } from "./actions";
import { REVENUE_BANDS, SPEND_BANDS } from "./bands";

export const metadata: Metadata = { title: "Apply" };

export default function ApplyPage() {
  return (
    <div className="container-page max-w-2xl py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Apply to work with us</h1>
      <p className="mt-2 text-ink-2">
        We take on brands where paid ads can profitably drive sales. Tell us a little about yours —
        or{" "}
        <a href="/sign-up" className="link">
          sign up directly
        </a>{" "}
        if you&apos;re ready to start.
      </p>
      <div className="card mt-8">
        <ActionForm action={submitApplication} submitLabel="Send application">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Your name" name="name" required autoComplete="name" />
            <Field label="Work email" name="email" type="email" required autoComplete="email" />
            <Field label="Company" name="company" required autoComplete="organization" />
            <Field label="Website" name="website" required placeholder="https://" />
            <Select
              label="Monthly online revenue"
              name="monthlyRevenueBand"
              options={REVENUE_BANDS.map((b) => ({ value: b, label: b }))}
            />
            <Select
              label="Monthly ad spend you're comfortable with"
              name="monthlyAdSpendBand"
              options={SPEND_BANDS.map((b) => ({ value: b, label: b }))}
            />
          </div>
          <TextArea label="Anything we should know? (optional)" name="message" rows={4} />
          <div aria-hidden="true" className="hidden">
            <label htmlFor="company_url">Leave this empty</label>
            <input id="company_url" name="company_url" tabIndex={-1} autoComplete="off" />
          </div>
        </ActionForm>
      </div>
    </div>
  );
}
