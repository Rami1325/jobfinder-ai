"""The demo mailbox (Phase 29 / B2): Gmail sync with no Google at all.

INBOX_FAKE_PROVIDER=true offers "Use demo mailbox" beside the Google connect, so
the whole flow — connect, sync, cards created and moved, the review queue, Undo,
the email timeline on a card — can be driven in a browser offline, the way
USE_STUB_LLM lets the tailor run without a key. The routes refuse it while the
access gate is on and the real model is in use, so a production deployment cannot
switch it on by accident.

Twelve messages, one of each thing the scanner has to get right, dated relative
to the moment the demo was CONNECTED rather than to "now": every backfill choice
(30/60/90 days) imports all of them, and a later sync of the same connection sees
the same ids and finds nothing new. With the stub classifier they come out as
5 cards created, 2 moved, 1 linked, 1 waiting for review, 2 digests dropped and
1 personal mail skipped. Every name in it is invented.
"""
from __future__ import annotations

from datetime import datetime, timezone

from app.core.gmail_api import FakeMailbox, FakeMessage

DEMO_EMAIL = "demo.inbox@example.com"
DAY_MS = 24 * 60 * 60 * 1000


def demo_messages(anchor: datetime) -> list[FakeMessage]:
    """The canned inbox, `days` before `anchor` (the connection's connected_at)."""
    if anchor.tzinfo is None:
        anchor = anchor.replace(tzinfo=timezone.utc)
    base = int(anchor.timestamp() * 1000)
    rows = [
        # (days before, from name, from address, subject, snippet, body)
        (27, "LinkedIn", "jobs-noreply@linkedin.com",
         "Dana, your application was sent to Kestrel Security",
         "Your application was sent to Kestrel Security",
         "Your application was sent to Kestrel Security\nSolutions Engineer\n"
         "Kestrel Security · Tel Aviv-Yafo, Israel\nApplied just now"),
        (25, "Paloma AI", "no-reply@ashbyhq.com",
         "Thanks for applying to Paloma AI!",
         "Hi Dana, thank you for applying for the Applied AI Engineer role at Paloma AI. "
         "A real person reads every application.",
         "Hi Dana,\n\nThank you for applying for the Applied AI Engineer role at Paloma AI. "
         "A real person reads every application.\n\nThe Paloma AI team"),
        (23, "Nimbus Analytics", "no-reply@eu.greenhouse-mail.io",
         "Thank you for applying to Nimbus Analytics",
         "Dana, thanks for applying. Your application for the Customer Success Engineer role "
         "has been received.",
         "Dana,\n\nYour application for the Customer Success Engineer role has been received "
         "and we will review it soon.\n\nNimbus Analytics"),
        (20, "LinkedIn", "jobs-noreply@linkedin.com",
         "Your application was viewed by Kestrel Security",
         "Your application was viewed by Kestrel Security Solutions Engineer Kestrel Security · "
         "Tel Aviv-Yafo, Israel",
         "Your application was viewed by Kestrel Security\nSolutions Engineer\n"
         "The hiring team viewed your application."),
        (16, "Maya Cohen", "maya.cohen@nimbus-analytics.example",
         "Nimbus Analytics - Customer Success Engineer - next steps",
         "Hi Dana, thanks for applying to the Customer Success Engineer role at Nimbus Analytics. "
         "We would love to schedule an interview next week.",
         "Hi Dana,\n\nThanks for applying to the Customer Success Engineer role at Nimbus "
         "Analytics. We would love to schedule an interview with our team next week.\n\n"
         "Maya Cohen\nTalent Acquisition, Nimbus Analytics"),
        (12, "Paloma AI Talent", "no-reply@ashbyhq.com",
         "Paloma AI Application Update",
         "Hi Dana, thank you for applying for the Applied AI Engineer role at Paloma AI. "
         "Unfortunately, we have decided to move forward with other applicants.",
         "Hi Dana,\n\nThank you for applying for the Applied AI Engineer role at Paloma AI. "
         "Unfortunately, we have decided to move forward with other applicants.\n\n"
         "The Paloma AI team"),
        (10, "HackerRank", "support@hackerrankforwork.example",
         "Invitation: Vertex Mobility coding test",
         "You have been invited to a coding test for the Mobile Engineer role at Vertex Mobility. "
         "The test takes 90 minutes.",
         "Hi Dana,\n\nYou have been invited to a coding test for the Mobile Engineer role at "
         "Vertex Mobility. The test takes 90 minutes.\n\nHackerRank"),
        (7, "שקד מדיקל", "yael@shaked-medical.example",
         "הזמנה לראיון עבודה - מנהל/ת מוצר",
         "היי דנה, נשמח להזמין אותך לראיון עבודה למשרת מנהל/ת מוצר ביום ראשון בשעה 10:00.",
         "היי דנה,\n\nנשמח להזמין אותך לראיון עבודה למשרת מנהל/ת מוצר ביום ראשון בשעה 10:00 "
         "במשרדינו.\n\nיעל, רכזת גיוס"),
        (5, "Ron Shapiro", "ron@talentbridge.example",
         "AI Engineer opportunity",
         "Hi Dana, I'm recruiting for an AI Engineer role at a confidential client in Tel Aviv. "
         "Open to a quick chat?",
         "Hi Dana,\n\nI'm recruiting for an AI Engineer role at a confidential client in Tel "
         "Aviv. Open to a quick chat this week?\n\nRon Shapiro, TalentBridge"),
        (3, "LinkedIn", "jobs-noreply@linkedin.com",
         "Meridian Labs is hiring for AI/ML",
         "Meridian Labs Lead AI/ML Engineer - Remote role and more",
         "Discover roles that match your interests."),
        (2, "AllJobs", "alljobs@alljob.co.il",
         "דנה, עלתה משרה חדשה שיכולה להתאים לך",
         "דנה שלום, להלן משרה שפורסמה באתר ומתאימה להגדרות החיפוש שלך",
         "דנה שלום, להלן משרה שפורסמה באתר."),
        (1, "Tomer", "tomer.friend@example.com",
         "Dinner on Friday?",
         "Are you free on Friday at 8? The usual place.",
         "Hey! Are you free on Friday at 8? The usual place."),
    ]
    return [
        FakeMessage(
            id=f"demo{index:04d}",
            internal_ms=base - days * DAY_MS + index * 60_000,
            from_name=name,
            from_email=address,
            subject=subject,
            snippet=snippet,
            body=body,
            thread_id=f"demothread{index:04d}",
        )
        for index, (days, name, address, subject, snippet, body) in enumerate(rows, start=1)
    ]


def demo_mailbox(anchor: datetime) -> FakeMailbox:
    return FakeMailbox(demo_messages(anchor), email=DEMO_EMAIL)
