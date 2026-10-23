<a id="readme-top"></a>

<p align="center">
  <a href="https://github.com/AQADIL/AkadilEDU-PRIME">
    <img src="assets/brand/prime-transparent.png" alt="AkadilEDU PRIME logo" width="150">
  </a>
</p>

<p align="center">
  <strong>Learn here. Prove yourself anywhere.</strong>
</p>

# AkadilEDU - Diploma Project

**Development of an Educational Ecosystem for UNT Mathematics Preparation with AI-Generated Personalized Learning Plans**

Astana IT University · Software Engineering · 2026-2027<br>
**Repository component:** Telegram bot and administration application<br>
**Documentation reviewed:** 22 October 2026

[Product guide](README.product.md) · [YouTrack project](https://akadiledu-diploma.youtrack.cloud/issues/AEDU) · [Task board](https://akadiledu-diploma.youtrack.cloud/agiles/204-1/218-1) · [Web repository](https://github.com/AQADIL/AkadilEDU) · [Telegram repository](https://github.com/AQADIL/AkadilEDU-PRIME)

## Contents

<details>
<summary><strong>Open the section navigator</strong></summary>

- [AkadilEDU ecosystem](#akadiledu-ecosystem)
- [Project overview](#project-overview)
- [Problem and target users](#problem-and-target-users)
- [Aim, objectives and expected outcomes](#aim-objectives-and-expected-outcomes)
- [Author, responsibilities and supervisor](#author-responsibilities-and-supervisor)
- [Scope and current development status](#scope-and-current-development-status)
- [Selected technologies](#selected-technologies)
- [Documentation and project evidence](#documentation-and-project-evidence)
- [Setup, execution and verification](#setup-execution-and-verification)
- [Submitted version](#submitted-version)
- [Ownership](#ownership)

</details>

## AkadilEDU ecosystem

<table align="center">
<tr>
<td width="1000" align="center">

<p align="center">
  <strong>AkadilEDU</strong> is the parent learning brand. <strong>AkadilEDU PRIME</strong> is its Telegram practice sub-brand.<br>
  Select a logo or product name to move between the two guides.
</p>

<p align="center">
  <a href="https://github.com/AQADIL/AkadilEDU/blob/main/README.md">
    <img src="https://github.com/AQADIL/AkadilEDU/raw/main/public/icons/logo-прозрачный.png" alt="AkadilEDU parent brand" width="110"><br>
    <strong>AkadilEDU</strong>
  </a><br>
  <sub>PARENT BRAND · WEB/PWA</sub><br>
  Courses, video lessons and exam preparation.<br>
  <a href="https://github.com/AQADIL/AkadilEDU/blob/main/README.md">Open the AkadilEDU guide →</a>
</p>

<p align="center">
  <strong>↓</strong><br>
  <sub>Telegram practice sub-brand</sub>
</p>

<p align="center">
  <a href="https://github.com/AQADIL/AkadilEDU-PRIME/blob/main/README.md">
    <img src="https://github.com/AQADIL/AkadilEDU-PRIME/raw/main/assets/brand/prime-transparent.png" alt="AkadilEDU PRIME Telegram sub-brand" width="96"><br>
    <strong>AkadilEDU PRIME</strong>
  </a><br>
  <sub>TELEGRAM PRACTICE</sub><br>
  Channel quizzes, mistake review and focused topic practice.<br>
  <strong>Current guide</strong>
</p>

</td>
</tr>
</table>

The brand relationship connects the product family. The two applications currently keep separate learner records; verified account linking and shared progress remain planned integrations.

## Project overview

AkadilEDU is a proposed integrated ecosystem for mathematics preparation for Kazakhstan's Unified National Testing (UNT / ҰБТ / ЕНТ). The diploma builds on an existing Web/PWA for courses and practice tests and an existing Telegram bot for quizzes, topic practice and mistake review.

The diploma contribution is to connect the two learning channels, identify gaps from actual learner attempts and generate individual learning plans that refer to available material. This repository contains Telegram practice, channel quizzes, personal review, administration and the server functions that support those flows.

The [product guide](README.product.md) documents the implemented application, its workflows and operating requirements. This README presents the academic scope and evidence expected for the diploma checkpoint.

## Problem and target users

Learners can complete a course or a practice test without knowing which mathematics topics deserve attention next. When study material, test results and short practice sessions are split between applications, the learner also has to connect those results manually.

The project addresses that preparation workflow by bringing evidence from both channels into a topic-level view and using it to recommend an actionable study plan. The accessibility motivation includes learners in rural areas and learners with limited financial resources who may have fewer opportunities for individual tutoring. Whether the system improves their access or learning outcomes must be established through user evidence and evaluation; universal free access is not an implemented guarantee.

| User group | Need addressed |
| --- | --- |
| Students preparing for UNT mathematics | Understand weak topics and decide what to study next |
| Students with limited tutoring opportunities | Use existing digital material and regular practice with clear guidance |
| Mathematics educators and content administrators | Maintain material and interpret progress at topic level |

User interviews and other research evidence must distinguish observed needs from these initial assumptions. They are tracked in [AEDU-2](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-2).

## Aim, objectives and expected outcomes

**Aim:** Develop an educational ecosystem that supports UNT mathematics preparation through connected learning channels and AI-generated individual learning plans grounded in learner progress.

The project objectives are to:

1. Establish verifiable learner needs, requirements and a realistic scope.
2. Define a consistent mathematics topic structure and a shared representation of practice results.
3. Link Web and Telegram identities through a verified, revocable mechanism.
4. Identify topic-level gaps from actual answers and make the evidence visible to the learner.
5. Generate structured study steps linked to existing courses and practice material.
6. Present and update the learner's plan across both applications.
7. Verify the implementation and assess the usefulness of the proposed preparation workflow.

| Expected outcome | Evidence of fulfilment |
| --- | --- |
| Connected Web and Telegram learning records | A verified linked account and consistent topic progress |
| Explainable diagnostic priorities | Recorded attempts and a visible reason for each weak-topic priority |
| A usable individual learning plan | Validated steps referring to resources that exist |
| An updated preparation workflow | New practice results reflected in progress and subsequent plan steps |
| An assessed engineering result | Recorded verification and an evaluation against a defined baseline |

These are expected diploma results. No improvement in UNT scores or learning effectiveness is asserted without collected evidence.

## Author, responsibilities and supervisor

| Role | Person | Responsibilities |
| --- | --- | --- |
| Sole student author | **Akadil Alish (Әліш Ақәділ)**, **SE-2426**, [AQADIL](https://github.com/AQADIL) | Problem analysis, requirements, architecture, UI/UX, Web and Telegram development, data integration, verification, documentation and project management |
| Scientific supervisor | **Elvira Aitmukhanbetova** | Academic supervision, review of selected significant deliverables and feedback at agreed checkpoints |

This is an individual diploma project. Tasks are assigned to the student. Supervisor feedback is recorded when an actual review occurs; the supervisor is not presented as a co-developer or as having already approved unfinished materials.

## Scope and current development status

### Existing implementation

| Component | Available implementation | Repository |
| --- | --- | --- |
| Web/PWA | Courses, video lessons, lesson quizzes, practice tests, results, learner accounts and content administration | [AkadilEDU](https://github.com/AQADIL/AkadilEDU) |
| Telegram | Topic/random practice, scheduled channel quizzes, personal mistake review, statistics and administration | [AkadilEDU PRIME](https://github.com/AQADIL/AkadilEDU-PRIME) |
| Project management | Assigned and prioritised tasks with expected outcomes, acceptance criteria and target dates | [AEDU project](https://akadiledu-diploma.youtrack.cloud/issues/AEDU) |

### Planned diploma development

| Work item | Current state | Task |
| --- | --- | --- |
| Verified account linking | Planned | [AEDU-12](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-12) |
| Shared learning events and topic progress | Planned | [AEDU-13](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-13) |
| AI-generated personalised learning plans | Planned | [AEDU-14](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-14) |
| Entry diagnostic and gap explanation | Planned | [AEDU-17](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-17) |
| Plan presentation in Web and Telegram | Planned | [AEDU-18](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-18) |

### Boundaries and limitations

The two applications currently have separate identity and progress records. Existing administrative AI tools assist with content workflows; they are not the proposed student learning-plan service. Official UNT question ownership, guaranteed admission results, a new foundation model and universal offline media access are outside the stated scope.

Learner records and assessment data must be handled with appropriate access controls. The AI component must handle insufficient evidence and invalid recommendations explicitly, and human review remains necessary for educational content and interpretation.

## Selected technologies

The following stack is present in the repositories; the integration design and model/provider choice for student plans remain subject to the technology comparison.

| Area | Current technologies | Role |
| --- | --- | --- |
| Web/PWA | React 18, React Router, Vite 7, Tailwind CSS, i18next | Courses, assessment UI and multilingual navigation |
| Telegram service | Node.js 22, grammY | Bot interactions, channel answers and topic practice |
| Administration Mini App | React 19, Vite 8, Tailwind CSS | Content and campaign management |
| Server and data | Cloud Functions, Realtime Database, Authentication, Storage | Server operations, identities, learning data and materials |
| Verification and delivery | ESLint, Node.js tests and rule emulators in the Web repository; GitHub Actions source/build/type/rule checks and Firebase deployment in the Telegram repository; GitHub Actions for the Web project | Available checks and configured delivery |

Dependency versions and scripts are defined by each component's manifests and lockfiles. The [product guide](README.product.md) gives the detailed implementation map. Technology alternatives and justification are tracked in [AEDU-5](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-5).

## Documentation and project evidence

The current navigation deliberately links to existing evidence or its tracked task. A task link does not mean that the corresponding academic document has been completed or approved.

| Required material | Available location / next deliverable |
| --- | --- |
| Project title, problem, users, scope and expected outcomes | Sections above; standalone proposal tracked in [AEDU-1](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-1) |
| Evidence of learner needs | [AEDU-2](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-2); discussion records and findings remain to be committed |
| Literature review | [AEDU-3](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-3); critical review and source analysis table remain to be committed |
| Comparison of existing systems | [AEDU-4](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-4); evidence-backed comparison remains to be committed |
| Technology comparison | [AEDU-5](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-5); alternatives and decision rationale remain to be committed |
| Requirements and acceptance criteria | [AEDU-6](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-6); system specification remains to be committed |
| Context, use-case and component diagrams | [AEDU-7](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-7); editable sources and exports remain to be committed |
| UX / prototype materials | [AEDU-8](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-8); integrated learner-plan flows remain to be documented |
| Verification and evaluation plan | [AEDU-9](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-9); measures, conditions and baseline remain to be committed |
| Responsibility, priorities, milestones and task outcomes | [YouTrack project](https://akadiledu-diploma.youtrack.cloud/issues/AEDU) and [board](https://akadiledu-diploma.youtrack.cloud/agiles/204-1/218-1) |
| Repository preparation | [AEDU-10](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-10) |
| Supervisor review and resulting revisions | [AEDU-11](https://akadiledu-diploma.youtrack.cloud/issue/AEDU-11); record actual feedback before closing |
| Implementation and individual contributions | [`bot/`](bot/), [`functions/`](functions/), [`admin-mini-app/`](admin-mini-app/); [commit history](https://github.com/AQADIL/AkadilEDU-PRIME/commits/main/) |

Academic material should be versioned alongside the implementation when ready. Diagrams need editable source as well as readable exports. Review comments and resulting revisions should remain traceable. The product guides and source code are not substitutes for the literature review, comparison tables or evaluation plan.

## Setup, execution and verification


### Telegram bot setup and checks

Use Node.js 22.12 or later in the Node.js 22 line, npm, a Telegram bot and a Firebase environment you are authorised to operate.

```sh
git clone https://github.com/AQADIL/AkadilEDU-PRIME.git
cd AkadilEDU-PRIME
npm ci
npm --prefix bot ci
npm --prefix functions ci
npm --prefix admin-mini-app ci
```

Configure the root, Functions and Mini App environment files from their respective `.env.example` templates. Keep bot tokens and signing secrets in server-side configuration or Secret Manager. Bootstrap the administrator only in your authorised environment; production identities and datasets are not included in the repository.

```sh
npm --prefix admin-mini-app run dev
npm --prefix admin-mini-app run lint
npm --prefix admin-mini-app run build
npm --prefix functions run prepare:bot
```

For local development without an active Telegram webhook, `npm --prefix bot start` uses polling. Deployed operation uses the configured webhook and scheduler. A real campaign also requires published questions and channel posting rights. Root tooling provides `npm run check` for source checks, the admin build and Firebase rule tests; rule tests require Java 21 or newer. Connected Telegram scenarios remain separate operator checks.

Follow the [deployment guide](README.product.md#deployment-and-first-run-setup) for complete environment, administrator, secret and deployment steps. The [product guide](README.product.md) describes product operation and deployment.

## Submitted version

| Component | Version for the current form |
| --- | --- |
| Web/PWA | [prob-period-1](https://github.com/AQADIL/AkadilEDU/tree/prob-period-1) |
| Telegram | [prob-period-1](https://github.com/AQADIL/AkadilEDU-PRIME/tree/prob-period-1) |

The `prob-period-1` tags identify previously fixed snapshots. README and other changes made later on `main` are not automatically included in those snapshots. A submitted tag must remain stable, and uploaded material must correspond to the declared version. These README updates do not move the existing tags.

## Ownership

Created and owned by **Akadil Alish**. The source and documentation are provided under the repository's proprietary [LICENSE](LICENSE). Third-party dependencies retain their respective terms. See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

<p align="right"><a href="#readme-top">Back to top ↑</a></p>
