# Month Document Template

Use one editable document per brand and month. Render clean prose for humans while retaining stable campaign IDs and revision metadata in the host record when available.

```markdown
# {Month YYYY} Campaign Copybook

Status: {stage}
Strategy revision: {n}
Brief revision: {n}
Copy revision: {n}

## Strategy & Concepts

### Monthly Strategy Summary

{A concise explanation of the month's objective, audience movement, offer posture, and strategic emphasis.}

### What Informed This Strategy

- Founder/operator direction:
- Launches and product priorities:
- Holidays or relevant moments:
- Promotions and verified terms:
- Content priorities:
- Confirmed prior results:
- Source freshness and limitations:

### Messaging Pillars

- {pillar and why it matters}

### Campaign Cadence & Sequencing

{Explain the email/SMS mix, sequence, and how campaigns avoid repetition or fatigue.}

| Date       | Channel | Campaign | Objective   | Audience  | Offer/content | Status   |
| ---------- | ------- | -------- | ----------- | --------- | ------------- | -------- |
| YYYY-MM-DD | Email   | {title}  | {objective} | {segment} | {focus}       | Proposed |

### Assumptions, Conflicts & Missing Inputs

- {clearly labeled item}

---

## Campaign Briefs

### {Channel} #{n}: {Campaign title}

Campaign ID: {stable id}
Proposed date: {date}
Status: {brief status}

> Objective: {one behavioral or business objective}
>
> Ideal result: {observable end state and metric}
>
> Audience: {segment, situation, exclusions}
>
> Angle: {central strategic argument}
>
> Why now: {role in the monthly sequence}
>
> Offer/content: {product, promotion, launch, or content}
>
> Proof and qualifications: {verified proof IDs and limits}
>
> Primary CTA: {one action}
>
> Test: {single-variable hypothesis or none}

Designer requirements:

- {required asset, hierarchy, placement, or review/testimonial need}

Risks and assumptions:

- {visible warning}

---

## Copy

### {Channel} #{n}: {Campaign title}

Campaign ID: {stable id}
Copy revision: {n}
QA: {passed | warnings | blocked}

#### Strategy Reference

{Approved objective, angle, audience, and CTA in compact form.}

#### Email Copy

Use for email campaigns only:

- Subject options:
- Preview text options:
- Email type:
- Header/hero copy:
- Body sections in final order:
- CTA labels and exact placement:
- Product, proof, review, or testimonial placement:
- Footer, terms, and disclaimer copy:

#### SMS Copy

Use for SMS campaigns only:

- SMS type:
- Primary message:
- Link placeholder and CTA:
- Required disclosure or opt-out language:
- Character count and estimated segment count when tooling supports it:
- One materially different test variant, if requested:

#### Designer Direction

- Intended visual hierarchy:
- Header/hero treatment:
- Section and CTA placement:
- Product imagery or asset needs:
- Review/testimonial treatment:
- Mobile considerations:
- Required legal or offer terms that must remain visible:

This is direction for a human designer, not a generated design.

#### QA & Review Notes

- Blocking issues repaired:
- Remaining warnings:
- Unsupported claims removed:
- Open comments:

---

## Approval History

| Scope | Revision | Decision | Reviewer | Date | Notes |
| ----- | -------- | -------- | -------- | ---- | ----- |
```

## Rendering Rules

- Keep strategy, briefs, and copy visibly distinct.
- Keep campaign titles and IDs consistent across sections.
- Put the strategic reason before final copy so reviewers and designers understand intent.
- Give every CTA, product block, review, testimonial, and required disclosure an explicit intended position.
- Do not invent assets. Label a desired asset as required or optional.
- Use placeholders for links unless a destination is verified.
- Avoid repeating the full Brand Brain in the document; include only applied rules and relevant caveats.
