# CV Humanization and Job-Tailoring System
## Implementation Specification for Claude Code

## 1. Project Objective

Refine the existing CV-generation application so that it produces CVs that are:

- Tailored to the target job description
- Grounded only in verified candidate experience
- Natural and human-written in tone
- Credible and defensible in interviews
- ATS-compatible without keyword stuffing
- Specific, concise, and technically accurate
- Free from obvious AI-generated résumé language

The system must behave primarily as a **fact-selection, evidence-ranking, and editing engine**, not as an unrestricted text-generation engine.

---

## 2. Core Problem

The current system can generate CV content from a job description, but the output may appear AI-generated because it:

- Uses generic résumé phrases
- Repeats the wording of the job description
- Overuses keywords
- Produces repetitive bullet structures
- Makes unsupported claims
- Invents or exaggerates metrics
- Uses vague adjectives instead of concrete evidence
- Makes every project sound equally important
- Writes polished but low-information sentences
- Creates content the candidate may not be able to defend in an interview

The solution is not simply to add an instruction such as:

> Make the CV sound more human.

That instruction is too vague. The application must use a structured multi-stage pipeline with evidence controls, retrieval, content planning, style constraints, and automated credibility checks.

---

# 3. Non-Negotiable Rules

The application must enforce the following rules throughout the pipeline.

1. Never invent metrics, responsibilities, employers, projects, skills, outcomes, or technologies.
2. Never claim leadership, ownership, scale, or production deployment unless supported by verified evidence.
3. Never copy full phrases or sentences directly from the job description.
4. Never add a skill only because it appears in the job description.
5. Every generated experience bullet must be traceable to one or more verified facts.
6. Every bullet must add distinct information.
7. Prefer concrete actions, tools, systems, constraints, and outcomes over adjectives.
8. Avoid exaggerated or generic résumé language.
9. Keep ATS keyword usage natural and factually justified.
10. The final CV must be defensible in a technical or behavioral interview.
11. If the candidate does not have evidence for a requirement, do not fabricate it.
12. Weak but accurate evidence is better than impressive but unsupported content.
13. The system should remove irrelevant experience rather than forcing all experience into every CV.
14. The final CV should tell one coherent professional story for the target role.

---

# 4. High-Level Architecture

```text
Candidate Career Database
        ↓
Job Description Parser
        ↓
Requirement and Keyword Extraction
        ↓
Candidate Evidence Retrieval
        ↓
Evidence Ranking and Filtering
        ↓
CV Positioning and Content Planning
        ↓
Experience Bullet Generation
        ↓
Fact and Claim Verification
        ↓
Human-Voice Editing
        ↓
ATS Keyword Validation
        ↓
Repetition and Credibility Audit
        ↓
Final CV Rendering
```

Each stage should return structured JSON wherever possible.

Do not run the entire process as one large LLM prompt.

---

# 5. Stage 1: Build a Structured Candidate Fact Bank

## Purpose

Create a reliable source of truth for all candidate experience.

The model should not receive only an old CV and be allowed to freely rewrite it. The system should store projects, roles, skills, tools, responsibilities, outcomes, and metrics as structured facts.

## Recommended Data Model

```json
{
  "fact_id": "project_meanpug_001",
  "category": "project",
  "project_name": "MeanPug Task Estimator",
  "company": "MeanPug",
  "role_context": "Work trial project",
  "problem": "Strategists needed budget and timeline estimates for new project requests.",
  "actions": [
    "Pulled historical task data from Toggl",
    "Matched new requests against similar completed tasks",
    "Calculated estimated budget and delivery timeline",
    "Integrated the estimation flow with Asana"
  ],
  "tools": [
    "Python",
    "Toggl API",
    "Asana API",
    "Claude Code"
  ],
  "outcomes": [
    "Completed the implementation in one day"
  ],
  "metrics": [],
  "deployment": null,
  "verified": true,
  "source": "candidate_input",
  "confidence": 1.0,
  "allowed_claims": [
    "Built a project estimation workflow",
    "Integrated Toggl and Asana",
    "Used historical tasks to estimate budget and timeline"
  ],
  "prohibited_claims": [
    "Reduced estimation time by a specific percentage",
    "Deployed enterprise-wide",
    "Managed a team"
  ]
}
```

## Required Fact Categories

The database should support:

- Employment history
- Freelance work
- Contract work
- Work trials
- Portfolio projects
- Side projects
- Education
- Certifications
- Tools and technologies
- Business outcomes
- Verified metrics
- Deployment environments
- Team collaboration
- Leadership responsibilities
- Domain experience
- Languages
- Soft skills with evidence

## Evidence Status

Every fact should have an evidence status:

```json
{
  "verified": true,
  "verification_level": "candidate_confirmed",
  "source": "manual_entry",
  "confidence": 1.0
}
```

Recommended verification levels:

- `document_verified`
- `candidate_confirmed`
- `system_observed`
- `inferred_needs_confirmation`
- `unverified`

Only the first three should be used automatically in the final CV.

---

# 6. Stage 2: Parse the Job Description

## Purpose

Convert the raw job description into a structured role profile.

## Required Output

```json
{
  "job_title": "GTM Engineer",
  "seniority": "mid_to_senior",
  "role_type": "technical_go_to_market",
  "primary_responsibilities": [
    "Build AI-driven GTM workflows",
    "Integrate CRM and enrichment tools",
    "Automate lead qualification and routing",
    "Improve sales productivity"
  ],
  "required_skills": [
    "API integrations",
    "CRM automation",
    "AI agents",
    "Workflow orchestration",
    "Data enrichment"
  ],
  "preferred_skills": [
    "HubSpot",
    "Clay",
    "Sales engagement platforms"
  ],
  "business_outcomes": [
    "Increase pipeline",
    "Reduce manual work",
    "Improve lead routing",
    "Improve CRM data quality"
  ],
  "domain_keywords": [
    "GTM",
    "CRM",
    "lead scoring",
    "enrichment",
    "routing",
    "automation"
  ],
  "expected_evidence": [
    "Examples of production workflows",
    "Examples of API integrations",
    "Examples of measurable business impact"
  ],
  "risk_flags": [
    "Role may expect direct revenue metrics",
    "Role may expect deep HubSpot experience"
  ]
}
```

## Parsing Requirements

The parser should distinguish between:

- Mandatory requirements
- Preferred requirements
- General company marketing language
- Responsibilities
- Business outcomes
- Seniority indicators
- Domain terminology
- Tools explicitly required
- Tools listed only as examples
- Cultural or behavioral traits
- Requirements that need direct evidence
- Requirements that can be demonstrated through transferable experience

Do not treat every word in the job description as an ATS keyword.

---

# 7. Stage 3: Retrieve Relevant Candidate Evidence

## Purpose

Select only the candidate facts that directly support the target role.

## Retrieval Inputs

- Parsed job requirements
- Candidate fact bank
- Target CV length
- Target role type
- Recency preference
- Candidate seniority
- User-selected must-include projects

## Recommended Scoring Formula

```text
Relevance Score =
0.35 semantic similarity
+ 0.25 required skill overlap
+ 0.20 business outcome overlap
+ 0.10 domain overlap
+ 0.10 recency or strategic importance
```

The exact weights can be configurable.

## Example Retrieval Output

```json
{
  "fact_id": "project_fixr_vapi_001",
  "semantic_similarity": 0.91,
  "skill_overlap": 0.88,
  "business_outcome_overlap": 0.72,
  "domain_overlap": 0.83,
  "recency_score": 0.95,
  "final_relevance_score": 0.87,
  "matched_requirements": [
    "API integrations",
    "AI agents",
    "Workflow automation"
  ],
  "selected": true
}
```

## Retrieval Rules

- Prefer evidence that satisfies multiple job requirements.
- Prefer recent and substantial work.
- Do not include weakly related projects only to fill space.
- Avoid selecting five projects that all prove the same skill.
- Ensure the selected evidence covers the role broadly.
- Keep at least one strong example for the most important requirement.
- Mark missing requirements explicitly.

## Missing Requirement Output

```json
{
  "requirement": "Direct HubSpot administration",
  "status": "not_supported",
  "transferable_evidence": [
    "CRM automation experience",
    "Monday.com integrations",
    "Salesforce-related workflows"
  ],
  "action": "Do not claim HubSpot administration"
}
```

---

# 8. Stage 4: Create the CV Positioning Strategy

## Purpose

Determine the professional story before generating content.

A strong CV should not be a random collection of job-description keywords. It should communicate a coherent candidate identity.

## Required Output

```json
{
  "target_positioning": "AI automation engineer who builds production workflows across APIs, CRMs, voice agents, and business operations.",
  "primary_strengths": [
    "End-to-end automation delivery",
    "API and CRM integrations",
    "AI workflow implementation",
    "Rapid prototyping and deployment"
  ],
  "secondary_strengths": [
    "Voice AI",
    "Lead research and qualification",
    "Operational tooling"
  ],
  "content_priorities": [
    "Fixr live voice-agent workflow",
    "MeanPug task estimator",
    "Clinic WhatsApp assistant",
    "Lead research and personalization engine"
  ],
  "content_to_remove": [
    "Unrelated early projects",
    "Generic skill claims without evidence"
  ],
  "tone": "direct, technical, evidence-based"
}
```

## Planning Requirements

The system should decide:

- Which professional identity best fits the role
- Which experience should lead
- Which skills deserve emphasis
- Which projects should be omitted
- Which claims require conservative wording
- Whether the candidate is a direct match or a transferable match
- How to organize the CV sections
- Which keywords belong in the summary, experience, projects, and skills sections
- Which weaknesses should not be hidden through fabrication

---

# 9. Stage 5: Generate CV Content

## Purpose

Create the first grounded draft from the selected evidence.

## Bullet Formula

Use this as a guide:

```text
Action + system or problem + implementation detail + result
```

The formula should guide content but should not force identical syntax.

## Strong Examples

> Built an n8n workflow that researched leads, scored ICP fit, generated personalized outreach, and routed qualified opportunities to Slack.

> Integrated Toggl history with a project-estimation service to identify similar completed tasks and estimate budget and delivery time for new Asana requests.

> Created a WhatsApp receptionist for a multi-doctor clinic that qualified leads, booked appointments, and routed each case to the appropriate doctor.

## Weak Example

> Leveraged advanced AI technologies to streamline business processes and improve operational efficiency.

The weak example is vague, generic, and difficult to verify.

## Bullet Requirements

Each bullet should:

- Represent a real action
- Contain distinct information
- Include a meaningful implementation detail
- Use specific tools only when relevant
- Include a result only when verified
- Avoid unsupported numbers
- Avoid repeating the job description
- Avoid excessive adjectives
- Usually stay between 18 and 35 words
- Be understandable to both recruiters and technical interviewers
- Be defensible in an interview

## Verb Variation

Avoid starting every bullet with the same verb.

Use verbs based on the actual action:

- Built
- Designed
- Integrated
- Automated
- Deployed
- Created
- Connected
- Migrated
- Implemented
- Reworked
- Diagnosed
- Improved
- Reduced
- Shipped
- Configured
- Developed

Do not randomly substitute verbs only for variation. The verb must accurately describe the candidate’s contribution.

---

# 10. Stage 6: Fact and Claim Verification

## Purpose

Validate every generated statement against the fact bank.

## Required Output Per Bullet

```json
{
  "bullet_id": "bullet_001",
  "bullet": "Built a Vapi workflow that generated customized demo agents and assigned phone numbers automatically.",
  "supporting_fact_ids": [
    "project_fixr_vapi_001",
    "integration_vapi_api_002"
  ],
  "matched_job_requirements": [
    "AI agents",
    "API integrations",
    "Workflow automation"
  ],
  "confidence": 0.97,
  "verification_status": "approved"
}
```

## Rejected Claim Example

```json
{
  "bullet_id": "bullet_002",
  "bullet": "Reduced response time by 70%.",
  "supporting_fact_ids": [],
  "confidence": 0.12,
  "verification_status": "rejected",
  "reason": "No verified evidence supports the metric."
}
```

## Verification Logic

Reject or revise a bullet when:

- It contains a number not present in the fact bank
- It claims management responsibility without evidence
- It claims production deployment without evidence
- It implies company-wide impact without evidence
- It uses a tool the candidate has not used
- It changes a prototype into a commercial product
- It changes participation into ownership
- It claims revenue impact without verified data
- It overstates the candidate’s seniority
- It introduces a new business outcome

No rejected bullet should reach the final CV.

---

# 11. Stage 7: Human-Voice Editing

## Purpose

Make the grounded draft sound natural, direct, and personal without introducing factual changes.

## Important Principle

Human writing does not mean:

- Adding deliberate grammar mistakes
- Using slang
- Making the CV casual
- Adding emotional storytelling
- Randomly varying sentence length
- Inserting first-person language
- Removing technical terminology

Human writing means:

- Specific observations
- Natural variation
- Consistent personal voice
- Conservative claims
- Uneven but meaningful detail
- Clear action and context
- Reduced boilerplate
- Language the candidate would actually use

## Phrases to Avoid

The editor should flag or remove phrases such as:

- Results-driven professional
- Dynamic professional
- Proven track record
- Cutting-edge
- Spearheaded
- Leveraged
- Utilized advanced technologies
- Demonstrated strong
- Successfully collaborated
- Optimized operational efficiency
- Scalable and robust solution
- Fast-paced environment
- Strategic thinker
- Passionate about innovation
- Best-in-class
- State-of-the-art
- Synergy
- End-to-end solution, when used without specifics

These terms are not always forbidden, but they should be treated as high-risk because they often add little information.

## Humanization Checks

For each bullet, ask:

1. Does this sound like a real person describing work they performed?
2. Does it contain observable detail?
3. Could the sentence apply to almost any candidate?
4. Does it use language copied from the job description?
5. Is the claim stronger than the supporting evidence?
6. Does it use unnecessary adjectives?
7. Does it repeat the structure of nearby bullets?
8. Would the candidate naturally say this in an interview?

---

# 12. Stage 8: Build a Candidate Writing Profile

## Purpose

Adapt the CV to the candidate’s real communication style.

## Source Material

The system may learn from:

- Existing CV bullets approved by the candidate
- Portfolio descriptions
- Interview answers
- LinkedIn posts
- Project explanations
- Professional emails
- User-edited versions of generated CVs
- Candidate feedback on accepted and rejected phrases

## Example Style Profile

```json
{
  "tone": "direct and technical",
  "sentence_length": "medium",
  "preferred_language": [
    "built",
    "integrated",
    "deployed",
    "workflow",
    "API",
    "production"
  ],
  "preferred_characteristics": [
    "implementation details",
    "conservative claims",
    "business context",
    "specific tools"
  ],
  "avoid": [
    "spearheaded",
    "cutting-edge",
    "dynamic professional",
    "results-driven",
    "leveraged"
  ],
  "detail_level": "specific",
  "claim_style": "evidence-based",
  "summary_style": "short and concrete"
}
```

## Learning Rules

- Learn only from text approved by the candidate.
- Do not learn from every generated draft.
- Store accepted edits as preference signals.
- Store rejected phrases as negative signals.
- Do not reproduce typos or poor grammar.
- Do not imitate highly informal language in the CV.
- Allow the user to reset or edit the writing profile.

---

# 13. Stage 9: ATS Keyword Validation

## Purpose

Ensure the CV remains compatible with ATS systems without turning it into a keyword list.

## Keyword Rules

A keyword should be included only when:

1. It appears in the job description or is clearly synonymous.
2. The candidate has verified evidence for it.
3. It fits naturally in the summary, experience, project, or skills section.
4. Its inclusion improves clarity or discoverability.

## Recommended Frequency

Approximate guidance:

- Critical keyword: 1 to 3 appearances
- Supporting keyword: 1 to 2 appearances
- Tool name: as needed, without repetition
- Do not repeat the same phrase in every section

## ATS Validation Output

```json
{
  "critical_keywords": [
    {
      "keyword": "API integrations",
      "required": true,
      "supported": true,
      "count": 2,
      "status": "good"
    },
    {
      "keyword": "HubSpot",
      "required": false,
      "supported": false,
      "count": 0,
      "status": "correctly_omitted"
    }
  ],
  "keyword_stuffing_detected": false,
  "job_description_phrase_overlap": 0.08
}
```

## Phrase Overlap

The system should calculate approximate phrase overlap with the job description.

High overlap can indicate that the CV is copying the employer’s wording rather than describing the candidate’s real experience.

Recommended target:

```text
Exact multi-word phrase overlap should remain low, except for necessary technical terms and product names.
```

---

# 14. Stage 10: Repetition Audit

## Purpose

Detect structural and vocabulary patterns that make the CV look machine-generated.

## Checks

- Repeated starting verbs
- Repeated sentence structures
- Repeated phrases
- Repeated keywords
- Repeated tool lists
- Repeated business outcomes
- Multiple bullets describing the same project behavior
- Excessive use of commas
- Similar bullet lengths across the entire CV
- Every bullet containing exactly one metric
- Every bullet ending with a business outcome
- Repeated use of “to improve,” “to streamline,” or “to optimize”

## Example Audit Output

```json
{
  "repeated_starting_verbs": {
    "Built": 5,
    "Developed": 4
  },
  "repeated_phrases": [
    {
      "phrase": "improve operational efficiency",
      "count": 3
    }
  ],
  "structure_similarity_score": 0.71,
  "status": "revision_required"
}
```

The editor should revise repetition without changing facts.

---

# 15. Stage 11: Credibility and Interview-Defensibility Audit

## Purpose

Ensure the CV contains claims the candidate can explain under questioning.

## Defensibility Test

For every bullet, ask:

> Could the candidate explain the architecture, decisions, constraints, difficulties, and outcome for at least five minutes in an interview?

If not:

- Remove the bullet
- Reduce the strength of the claim
- Add missing context from verified evidence
- Ask the candidate to verify or expand the fact before including it

## Example

Too strong:

> Architected enterprise-grade automation infrastructure.

Defensible:

> Designed and deployed self-hosted n8n workflows with API integrations, branching, error handling, and CRM updates.

The second version is narrower but more credible.

## Credibility Risk Categories

- Unsupported metric
- Exaggerated ownership
- Inflated seniority
- Unverified production claim
- Vague business impact
- Tool-name padding
- Copied job-description language
- Artificial leadership language
- Excessive scale claims
- Unclear candidate contribution

---

# 16. Stage 12: CV Scoring

Do not use a single overall quality score only.

Score each dimension separately so problems can be diagnosed.

## Recommended Score Object

```json
{
  "job_relevance": 88,
  "fact_grounding": 97,
  "specificity": 84,
  "human_voice": 81,
  "keyword_coverage": 86,
  "readability": 89,
  "interview_defensibility": 95,
  "repetition_risk": 12,
  "job_description_copy_risk": 8,
  "unsupported_claims": 0
}
```

## Recommended Thresholds

```json
{
  "fact_grounding_minimum": 95,
  "unsupported_claims_maximum": 0,
  "interview_defensibility_minimum": 90,
  "repetition_risk_maximum": 25,
  "job_description_copy_risk_maximum": 15,
  "human_voice_minimum": 75
}
```

A CV should not be finalized when it fails grounding or unsupported-claim checks, even if the ATS score is high.

---

# 17. Recommended LLM Prompt: Job Description Parser

```text
You are parsing a job description into a structured role profile.

Return valid JSON only.

Extract:
- job title
- seniority
- role type
- primary responsibilities
- mandatory skills
- preferred skills
- business outcomes
- domain keywords
- tools explicitly required
- tools listed only as examples
- expected evidence
- cultural traits
- seniority indicators
- possible candidate risk areas

Rules:
1. Do not treat company marketing language as a candidate requirement.
2. Separate mandatory requirements from preferred requirements.
3. Distinguish tools from broader capabilities.
4. Do not invent requirements.
5. Preserve technical terminology where necessary.
```

---

# 18. Recommended LLM Prompt: Evidence Selector

```text
You are selecting verified candidate evidence for a target job.

Inputs:
- parsed job profile
- candidate fact bank
- target CV length
- candidate writing preferences

Return valid JSON only.

For each candidate fact:
- calculate relevance
- identify matched job requirements
- identify supported business outcomes
- identify credibility limitations
- decide whether to select it
- explain why

Rules:
1. Select only facts that materially support the target role.
2. Prefer evidence that supports multiple important requirements.
3. Do not select irrelevant projects only to fill space.
4. Do not claim missing requirements.
5. Mark transferable experience separately from direct experience.
6. Keep coverage diverse and avoid redundant examples.
```

---

# 19. Recommended LLM Prompt: CV Content Planner

```text
You are planning a targeted CV before writing it.

Inputs:
- parsed job profile
- selected candidate evidence
- candidate writing profile
- target CV structure

Return valid JSON only.

Decide:
- target candidate positioning
- professional narrative
- top strengths
- secondary strengths
- which roles and projects to include
- which facts to emphasize
- which facts to omit
- section order
- keyword placement
- claims that require conservative wording
- missing requirements that must not be fabricated

Rules:
1. Build one coherent professional story.
2. Do not maximize keyword count.
3. Do not include every project.
4. Do not hide missing requirements through vague wording.
5. Prioritize direct, verified evidence.
```

---

# 20. Recommended LLM Prompt: Bullet Generator

```text
You are editing a professional CV using only the verified candidate facts provided.

Your goal is not to make the candidate sound impressive through adjectives.
Your goal is to make the candidate's actual experience clear, relevant, specific, and credible.

Rules:
1. Never invent metrics, responsibilities, employers, skills, tools, or outcomes.
2. Do not copy phrases directly from the job description.
3. Avoid generic résumé language such as:
   - results-driven
   - cutting-edge
   - spearheaded
   - leveraged
   - dynamic professional
   - proven track record
4. Prefer concrete systems, actions, implementation details, tools, constraints, and verified outcomes.
5. Each bullet must contain new information.
6. Use natural variation in sentence structure.
7. Keep most bullets between 18 and 35 words.
8. Do not claim leadership, scale, or production ownership unless supported.
9. Preserve important ATS keywords only where factually justified.
10. Write in a direct, technically credible voice.
11. Do not add a result when no result is verified.
12. Do not use more than one major claim per bullet unless both are tightly connected.

For each generated bullet, return:
- bullet
- supporting_fact_ids
- matched_job_requirements
- confidence
- claim_strength
```

---

# 21. Recommended LLM Prompt: Credibility Reviewer

```text
You are reviewing CV content for factual credibility and interview defensibility.

Inputs:
- generated CV bullets
- supporting candidate facts
- parsed job profile

Return valid JSON only.

For every bullet:
- verify every factual claim
- verify every metric
- verify every tool
- verify the candidate's level of ownership
- check whether the bullet copies the job description
- check whether the bullet contains vague résumé language
- check whether the candidate could defend the claim in an interview
- approve, revise, or reject the bullet

Rules:
1. Reject unsupported metrics.
2. Reject invented tools or responsibilities.
3. Reject inflated leadership and scale claims.
4. Reject production claims without evidence.
5. Reject bullets that merely restate the job description.
6. Prefer conservative, precise wording over impressive wording.
7. Do not introduce new facts during revision.
```

---

# 22. Recommended LLM Prompt: Human-Voice Editor

```text
You are editing already verified CV content to make it sound natural and human-written.

Do not change facts.
Do not add metrics.
Do not add tools.
Do not increase the strength of claims.
Do not copy the job description.

Improve:
- clarity
- sentence flow
- natural variation
- specificity
- directness
- consistency with the candidate's writing profile

Reduce:
- generic résumé phrases
- repetitive verbs
- repetitive structures
- unnecessary adjectives
- corporate filler
- keyword stuffing
- artificial polish

The final writing should sound like a technically credible candidate describing real work.
```

---

# 23. Recommended LLM Prompt: Final CV Auditor

```text
You are performing the final audit of a targeted CV.

Return valid JSON only.

Score:
- job relevance
- fact grounding
- specificity
- human voice
- ATS keyword coverage
- readability
- interview defensibility
- repetition risk
- job-description-copy risk
- unsupported claim count

Also return:
- blocking issues
- non-blocking improvements
- repeated verbs
- repeated phrases
- unsupported statements
- overly vague bullets
- bullets that should be removed
- keywords that are missing but supported
- keywords that should be removed because they are unsupported

Rules:
1. Unsupported claim count must be zero.
2. Fact grounding has priority over ATS optimization.
3. Do not recommend adding unsupported skills.
4. Do not recommend adding fabricated metrics.
5. Do not approve the CV when a blocking credibility issue exists.
```

---

# 24. Recommended API and Service Boundaries

A possible backend structure:

```text
/services
  /job-parser
  /candidate-profile
  /evidence-retrieval
  /cv-planner
  /bullet-generator
  /fact-verifier
  /humanizer
  /ats-validator
  /credibility-auditor
  /cv-renderer
```

## Suggested Responsibilities

### `job-parser`
- Accept raw job description
- Return structured role profile

### `candidate-profile`
- Store and retrieve verified candidate facts
- Store candidate writing profile
- Store approved and rejected claims

### `evidence-retrieval`
- Rank facts against the role
- Return selected facts and coverage gaps

### `cv-planner`
- Create the content strategy
- Select section order and positioning

### `bullet-generator`
- Generate grounded bullets from approved facts

### `fact-verifier`
- Verify all claims and metrics

### `humanizer`
- Improve voice without changing facts

### `ats-validator`
- Check supported keyword coverage
- Detect keyword stuffing and phrase copying

### `credibility-auditor`
- Test interview defensibility
- Detect exaggeration and unsupported claims

### `cv-renderer`
- Render the approved structured content into PDF, DOCX, or Markdown templates

---

# 25. Recommended Database Entities

```text
Candidate
CandidateFact
CandidateSkill
CandidateProject
CandidateRole
CandidateMetric
EvidenceSource
WritingProfile
JobDescription
ParsedJobProfile
Requirement
EvidenceMatch
CVPlan
CVVersion
CVSection
CVBullet
BulletEvidenceLink
AuditResult
CandidateFeedback
ApprovedPhrase
RejectedPhrase
```

## Important Relationship

Every CV bullet should have one or more `BulletEvidenceLink` records.

```text
CVBullet → BulletEvidenceLink → CandidateFact
```

A bullet without an evidence link should not be renderable in the final CV.

---

# 26. Feedback Loop

The application should learn from candidate edits.

## Store Positive Signals

- Bullet accepted without edits
- Bullet manually approved
- Phrase repeatedly retained
- Project repeatedly selected
- Preferred summary style
- Preferred technical detail level

## Store Negative Signals

- Bullet deleted
- Phrase replaced
- Claim weakened
- Project removed
- Word marked as unnatural
- User says content sounds AI-generated
- User rejects an exaggerated statement

## Important Constraint

Do not automatically retrain or update the style profile from unapproved generated output.

Only learn from:

- User-approved content
- User-edited final content
- Explicit user feedback

---

# 27. UI Recommendations

The interface should show the candidate why content was generated.

For each bullet, display:

- Generated bullet
- Supporting project or experience
- Matching job requirement
- Confidence score
- Claim-strength indicator
- Edit button
- Approve button
- Reject button
- Evidence details
- Warning when a metric is unsupported

## Example

```text
Bullet:
Built an n8n workflow that researched leads, scored ICP fit, generated personalized outreach, and routed qualified opportunities to Slack.

Evidence:
- AI Lead Research and Personalization Engine
- n8n workflow
- OpenAI structured output
- Slack routing

Matched requirements:
- Lead enrichment
- AI workflow automation
- CRM and sales operations

Confidence:
96%

Status:
Verified
```

This increases trust and makes manual review faster.

---

# 28. Metrics to Track

Track product quality over time using:

- Percentage of bullets linked to evidence
- Unsupported claim count
- User approval rate per bullet
- Average number of edits per bullet
- Percentage of generated bullets deleted
- Repeated phrase rate
- Job-description phrase-overlap rate
- Keyword coverage
- Candidate-reported human-likeness score
- Recruiter response rate
- Interview conversion rate
- User-reported interview defensibility
- Average time to produce an approved CV

Do not optimize only for ATS keyword coverage.

---

# 29. Acceptance Criteria

The refinement is complete when the application can meet all of the following:

## Grounding

- 100% of final bullets have one or more evidence links.
- Unsupported claim count is zero.
- Unsupported metric count is zero.
- No new tools or responsibilities are introduced during humanization.

## Human Voice

- No excessive use of generic résumé phrases.
- No obvious repetition of sentence structure.
- No repeated starting verb more than an acceptable configured threshold.
- Low exact phrase overlap with the job description.
- Candidate can approve most bullets with minimal editing.

## Relevance

- The CV clearly targets the selected role.
- The strongest evidence appears first.
- Irrelevant projects are removed.
- Missing requirements are not fabricated.

## ATS

- Supported critical keywords are included naturally.
- Unsupported keywords are omitted.
- Keyword stuffing is not detected.
- The CV remains simple and ATS-readable.

## Credibility

- Every bullet is interview-defensible.
- Leadership and ownership claims match evidence.
- Prototype, production, freelance, and employment contexts are represented accurately.
- Results are stated only when verified.

---

# 30. Recommended Implementation Order

## Phase 1: Grounding Foundation

1. Create the structured candidate fact bank.
2. Add verification status and source tracking.
3. Link every generated bullet to fact IDs.
4. Block unsupported metrics and tools.

## Phase 2: Job Parsing and Retrieval

1. Build the job-description parser.
2. Extract requirements and business outcomes.
3. Implement evidence retrieval and ranking.
4. Show matched and missing requirements.

## Phase 3: Content Planning and Generation

1. Add the CV positioning stage.
2. Generate only from selected evidence.
3. Use structured bullet-generation output.
4. Keep sections and bullet counts configurable.

## Phase 4: Humanization and Quality Control

1. Add the credibility reviewer.
2. Add the human-voice editor.
3. Add repetition detection.
4. Add job-description phrase-overlap detection.
5. Add ATS keyword validation.

## Phase 5: Personalization

1. Build the candidate writing profile.
2. Learn from approved edits.
3. Store accepted and rejected language patterns.
4. Allow manual control over tone and detail level.

## Phase 6: Product Measurement

1. Add quality scores.
2. Track approval and edit rates.
3. Track unsupported-claim failures.
4. Track recruiter and interview outcomes where available.

---

# 31. Anti-Patterns to Avoid

Do not implement the system as:

```text
Job description + old CV + one prompt = final CV
```

Do not:

- Ask the model to “make it impressive”
- Ask the model to “sound human” without constraints
- Allow the model to generate metrics
- Add every job-description keyword
- Copy employer wording into candidate experience
- Use adjectives as a substitute for evidence
- Produce identical bullet structures
- Automatically claim leadership
- Treat every project as production-grade
- Allow the humanizer to introduce new facts
- Use a high ATS score as proof of CV quality
- hide missing experience with vague language

---

# 32. Definition of Done

The application should generate a CV that reads as if a technically competent candidate carefully selected and edited their real experience for one specific job.

The final output should be:

- Specific
- Grounded
- Relevant
- Conservative
- Natural
- ATS-compatible
- Easy to scan
- Easy to defend
- Free from fabricated claims
- Clearly different from generic AI-generated résumé content
