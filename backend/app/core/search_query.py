"""Search in plain words (Phase 32): one line typed into the Jobs page, such as
"משרות QA בתל אביב, היברידי, עד שנתיים ניסיון" or "remote backend jobs in Europe,
senior", read into the search form's OWN fields. Rules first, the model only for
what the rules leave (the inbox's "rules before the model", `inbox.md`).

**Deterministic, and pinned that way through the AST** (smoke, *search in plain
words*): no model, no network, no clock, and it imports exactly `__future__`,
`re`, `unicodedata` and `dataclasses`. It also VALIDATES what the model says (`merge_model`), so the
model can only ever fill a field this module can read back: a title of a few
words, one of the places below, the three work modes, the worldwide pass.

What it reads, and what each reading fills:
- a PLACE in Israel (`_PLACES`), in Hebrew or English, with ב/ל/מ/ה/ו/ש/כ glued
  on ("בתל אביב", "מחיפה") -> `location`, in the English form the Jobs page's
  own presets use ("Tel Aviv, Israel"), which every board reads (see
  `LOCATION_PRESETS` in `pages/jobs/shared.ts`). The country itself -> "Israel".
  A REGION (the center, the north, the Sharon) is not a location any board can
  filter on, so it reads as "Israel" with the note `region`;
- ABROAD (Europe, the US, the UK, worldwide, חו"ל) -> `include_worldwide`, and
  "remote" among the work modes, because the worldwide pass keeps only postings
  that say they are remote (`job-search.md`, *Work mode*). It searches the US,
  the UK and the EU together; "Europe" alone is not a filter the app has;
- a WORK MODE (remote / מהבית, hybrid / היברידי, on-site / מהמשרד) -> `work_mode`;
- YEARS OF EXPERIENCE: an upper bound of two years or less ("עד שנתיים ניסיון",
  "no experience") reads as junior and a lower bound of five or more as senior,
  and that word is added to the title ("Junior QA"), because a board keyword is
  the only place a seniority can go. Anything in between is read and dropped
  with the note `experience`. A seniority WORD the user typed (senior, בכיר,
  ג'וניור) is simply part of the title, where they put it;
- what is left, when every word of it is a known role word (`_ROLE_WORDS`) ->
  the title. Anything else left over is `unread`: the one part the model sees.

A Latin word needs a boundary ("lod" is inside "lodging"); a Hebrew phrase may
carry up to two prefix letters and must END at a word boundary, the house rule
(`scoring.md`) with the false-positive guard beside it (smoke pins both).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, replace

# The three work modes, in `app.models.WORK_MODES` order (smoke pins them equal):
# a stored `work_mode` is written in this ONE order.
MODES = ("remote", "onsite", "hybrid")

# The longest line the page sends; the route refuses longer by BYTES (413, kind
# "query", `max_search_query_kb`). This is the title's own shape.
TITLE_MAX_CHARS = 60
TITLE_MAX_WORDS = 6
MAX_KEYWORDS = 5  # job_search.MAX_TITLES

# --------------------------------------------------------------------------- #
# Normalising
# --------------------------------------------------------------------------- #
_FOLD = str.maketrans(
    {
        "׳": "'",  # Hebrew geresh
        "״": '"',  # Hebrew gershayim
        "’": "'",
        "‘": "'",
        "“": '"',
        "”": '"',
        "`": "'",
        "־": "-",  # maqaf
        "–": "-",
        "—": "-",
    }
)
_POINTS = re.compile("[֑-ֽֿ-ׇ]")  # niqqud and cantillation
_SPACES = re.compile(r"\s+")


def normalize(text: str) -> str:
    """NFKC, Hebrew punctuation folded to ASCII quotes and hyphens (two gereshes
    typed for a gershayim, ב''ש, read as one), vowel points dropped, whitespace
    collapsed."""
    text = unicodedata.normalize("NFKC", text or "").translate(_FOLD).replace("''", '"')
    return _SPACES.sub(" ", _POINTS.sub("", text)).strip()


# --------------------------------------------------------------------------- #
# Vocabulary
# --------------------------------------------------------------------------- #
# Canonical English value -> how people write it. The Hebrew forms carry no
# prefix: `_he` adds up to two (ב/ל/מ/ה/ו/ש/כ) and the match must end the word.
# A bare "ראשון" is left out on purpose: it is also "first" and "Sunday".
_PLACES: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "Tel Aviv, Israel": (
        ("tel aviv", "tel-aviv", "telaviv", "tel aviv yafo", "tel aviv-yafo", "tlv"),
        ("תל אביב", "תל אביב יפו", "תל אביב-יפו", 'ת"א'),
    ),
    "Jerusalem, Israel": (("jerusalem",), ("ירושלים", "י-ם")),
    "Haifa, Israel": (("haifa",), ("חיפה",)),
    "Herzliya, Israel": (("herzliya", "herzlia", "herzliyya", "herzliya pituach"), ("הרצליה", "הרצליה פיתוח")),
    "Ramat Gan, Israel": (("ramat gan",), ("רמת גן", 'ר"ג')),
    "Petah Tikva, Israel": (
        ("petah tikva", "petach tikva", "petah tiqva", "petach tikvah", "petah tikvah"),
        ("פתח תקווה", "פתח תקוה", 'פ"ת'),
    ),
    "Beer Sheva, Israel": (("beer sheva", "be'er sheva", "beersheba", "beersheva", "beer sheba"), ("באר שבע", 'ב"ש')),
    "Netanya, Israel": (("netanya", "natanya"), ("נתניה",)),
    "Ra'anana, Israel": (("raanana", "ra'anana", "ra anana"), ("רעננה",)),
    "Kfar Saba, Israel": (("kfar saba", "kefar sava", "kfar sava"), ("כפר סבא", 'כפ"ס')),
    "Rehovot, Israel": (("rehovot", "rechovot"), ("רחובות",)),
    "Yokneam, Israel": (("yokneam", "yoqneam", "yokneam illit"), ("יקנעם", "יוקנעם", "יקנעם עילית")),
    "Lod, Israel": (("lod",), ("לוד",)),
    "Rishon LeZion, Israel": (
        ("rishon lezion", "rishon le zion", "rishon letzion", "rishon lezyon"),
        ("ראשון לציון", 'ראשל"צ'),
    ),
    "Holon, Israel": (("holon",), ("חולון",)),
    "Bat Yam, Israel": (("bat yam",), ("בת ים",)),
    "Bnei Brak, Israel": (("bnei brak", "bene beraq"), ("בני ברק",)),
    "Givatayim, Israel": (("givatayim", "giv'atayim"), ("גבעתיים",)),
    "Hod HaSharon, Israel": (("hod hasharon", "hod ha sharon", "hod ha'sharon"), ("הוד השרון",)),
    "Ramat HaSharon, Israel": (("ramat hasharon", "ramat ha sharon"), ("רמת השרון",)),
    "Rosh HaAyin, Israel": (("rosh haayin", "rosh ha'ayin", "rosh ha ayin"), ("ראש העין",)),
    "Modiin, Israel": (("modiin", "modi'in"), ()),
    "Ashdod, Israel": (("ashdod",), ("אשדוד",)),
    "Ashkelon, Israel": (("ashkelon",), ("אשקלון",)),
    "Nazareth, Israel": (("nazareth",), ("נצרת",)),
    "Caesarea, Israel": (("caesarea",), ("קיסריה",)),
    "Or Yehuda, Israel": (("or yehuda",), ("אור יהודה",)),
    "Airport City, Israel": (("airport city",), ("איירפורט סיטי",)),
    "Ness Ziona, Israel": (("ness ziona", "nes ziona"), ("נס ציונה",)),
    "Yavne, Israel": (("yavne", "yavneh"), ()),
    "Kiryat Gat, Israel": (("kiryat gat",), ("קריית גת", "קרית גת")),
    "Kiryat Ono, Israel": (("kiryat ono",), ("קריית אונו", "קרית אונו")),
    "Karmiel, Israel": (("karmiel", "carmiel"), ("כרמיאל",)),
    "Afula, Israel": (("afula",), ("עפולה",)),
    "Eilat, Israel": (("eilat",), ()),
    "Nahariya, Israel": (("nahariya",), ("נהריה",)),
    "Hadera, Israel": (("hadera",), ("חדרה",)),
    "Ramla, Israel": (("ramla", "ramle"), ("רמלה",)),
    "Tiberias, Israel": (("tiberias",), ("טבריה",)),
    "Beit Shemesh, Israel": (("beit shemesh",), ("בית שמש",)),
    "Migdal HaEmek, Israel": (("migdal haemek", "migdal ha'emek"), ("מגדל העמק",)),
    "Tirat Carmel, Israel": (("tirat carmel",), ("טירת כרמל",)),
    "Kiryat Bialik, Israel": (("kiryat bialik",), ("קריית ביאליק", "קרית ביאליק")),
    "Kiryat Motzkin, Israel": (("kiryat motzkin",), ("קריית מוצקין", "קרית מוצקין")),
    "Kiryat Ata, Israel": (("kiryat ata",), ("קריית אתא", "קרית אתא")),
    "Kiryat Yam, Israel": (("kiryat yam",), ("קריית ים", "קרית ים")),
    "Kiryat Shmona, Israel": (("kiryat shmona",), ("קריית שמונה", "קרית שמונה")),
    "Nesher, Israel": (("nesher",), ()),
    "Zichron Yaakov, Israel": (("zichron yaakov", "zikhron yaakov", "zichron ya'akov"), ("זכרון יעקב",)),
    "Pardes Hanna, Israel": (("pardes hanna", "pardes hana", "pardes hanna-karkur"), ("פרדס חנה",)),
    "Even Yehuda, Israel": (("even yehuda",), ("אבן יהודה",)),
    "Shoham, Israel": (("shoham",), ()),
    "Yehud, Israel": (("yehud",), ()),
    "Dimona, Israel": (("dimona",), ("דימונה",)),
    "Safed, Israel": (("safed", "tzfat", "zefat"), ("צפת",)),
    "Umm al-Fahm, Israel": (("umm al-fahm", "umm al fahm"), ("אום אל פחם", "אום אל-פחם")),
    "Sakhnin, Israel": (("sakhnin",), ("סחנין",)),
    "Rahat, Israel": (("rahat",), ("רהט",)),
    "Tayibe, Israel": (("tayibe", "taibe", "tayibeh"), ("טייבה",)),
    "Arad, Israel": (("arad",), ("ערד",)),
    "Netivot, Israel": (("netivot",), ()),
    "Rosh Pina, Israel": (("rosh pina", "rosh pinna"), ("ראש פינה",)),
    "Nof HaGalil, Israel": (("nof hagalil", "nof ha galil", "nazareth illit"), ("נוף הגליל", "נצרת עילית")),
    "Ma'ale Adumim, Israel": (("maale adumim", "ma'ale adumim"), ("מעלה אדומים",)),
    "Or Akiva, Israel": (("or akiva",), ("אור עקיבא",)),
    "Kfar Yona, Israel": (("kfar yona",), ("כפר יונה",)),
    "Israel": (("israel", "all of israel", "anywhere in israel"), ("ישראל", "כל הארץ", "רחבי הארץ", "בארץ")),
}
# Hebrew place names that are also ordinary words, read as a place only with a
# prefix letter or a place-word before them: "אנליסט מודיעין" is an intelligence
# analyst, "במודיעין" is in Modiin; "אילת" is also a name, "יבנה" a verb, "נשר" an
# eagle, "שוהם" a gemstone, "נתיבות" paths. (Sderot is left out: "בשדרות רוטשילד"
# is an address on a boulevard, and it takes a prefix just the same.)
_PLACES_HE_PREFIXED: dict[str, tuple[str, ...]] = {
    "Modiin, Israel": ("מודיעין",),
    "Eilat, Israel": ("אילת",),
    "Yavne, Israel": ("יבנה",),
    "Nesher, Israel": ("נשר",),
    "Shoham, Israel": ("שוהם",),
    "Yehud, Israel": ("יהוד",),
    "Netivot, Israel": ("נתיבות",),
}
# A region reads as the whole country, with a note saying so: no board filters
# on one. Hebrew forms need a place-word before them ("במרכז", "אזור הצפון"),
# because a bare "מרכז" is also a coordinator (מרכז/ת) and a service center.
_REGIONS_EN = (
    "central israel", "center of israel", "centre of israel", "the center", "the centre", "center district",
    "central district", "gush dan", "the sharon", "sharon area", "sharon region", "northern israel",
    "north of israel", "the north", "southern israel", "south of israel", "the south", "the shfela",
    "shephelah", "the negev", "the galilee", "the krayot", "haifa bay",
)
_REGIONS_HE = (
    "מרכז הארץ", "גוש דן", "השרון", "צפון הארץ", "דרום הארץ", "השפלה", "הנגב", "הגליל", "הקריות", "המרכז",
    "הצפון", "הדרום", "אזור המרכז", "אזור הצפון", "אזור הדרום", "אזור השרון",
)
_REGIONS_HE_PREFIXED = ("מרכז", "צפון", "דרום")  # only with ב/ל/מ glued on: "במרכז", "לצפון"

# Jobs abroad: the worldwide pass (US, UK and EU, remote only). Upper-case forms
# are matched case-sensitively, because "us" is also a word.
_ABROAD_EN = (
    "worldwide", "world wide", "anywhere in the world", "abroad", "overseas", "outside israel", "outside of israel",
    "europe", "european union", "the eu", "united states", "the states", "usa", "u.s.", "u.s.a.", "america",
    "north america", "united kingdom", "the uk", "u.k.", "england", "britain", "great britain", "london",
    "germany", "berlin", "france", "paris", "netherlands", "amsterdam", "spain", "ireland", "dublin",
    "new york", "california", "san francisco",
)
_ABROAD_CASED = ("US", "UK", "EU", "USA")
_ABROAD_HE = (
    'חו"ל', "חוץ לארץ", "מחוץ לארץ", "מחוץ לישראל", "בעולם", "כל העולם", "מכל העולם", "אירופה", 'ארה"ב',
    "ארצות הברית", "אמריקה", "אנגליה", "בריטניה", "לונדון", "גרמניה", "ברלין", "צרפת", "הולנד",
)

_WORK_EN = {
    "remote": (
        r"fully remote", r"100% remote", r"remote[\s-]+first", r"remote(?![\s-]+sensing)", r"remotely",
        r"work(?:ing)? from home", r"from home", r"wfh", r"home[\s-]+based", r"telecommut\w*",
    ),
    "hybrid": (
        r"hybrid(?![\s-]+(?:cloud|apps?|mobile|models?|vehicles?|cars?))", r"partly remote",
        r"partially remote", r"part[\s-]+remote",
        r"(?:a few|some|one|two|three|[1-4])\s+days?\s+(?:a\s+week\s+)?(?:from home|remote|in the office|at the office)",
    ),
    "onsite": (
        r"on[\s-]?site", r"in[\s-]+office", r"in the office", r"at the office", r"from the office",
        r"office[\s-]+based", r"in[\s-]+person",
    ),
}
_WORK_HE = {
    "remote": ("עבודה מהבית", "מהבית", "עבודה מרחוק", "מרחוק", "רימוט", "רמוט", "100% מהבית"),
    "hybrid": (
        "היברידי", "היברידית", "היבריד", "מודל היברידי", "חלקית מהבית", "חלק מהבית", "יום מהבית",
        "יומיים מהבית", "חלק מהזמן מהבית", "משולב בית",
    ),
    "onsite": ("עבודה מהמשרד", "מהמשרד", "נוכחות מלאה", "נוכחות במשרד", "פרונטלי", "פרונטלית", "נוכחות פיזית"),
}
# "במשרד" alone is on-site only at the END of a phrase ("מזכירה במשרד" is still
# an office job), never before a noun ("במשרד עורכי דין" is a law firm).
_WORK_HE_TAIL = ("במשרד",)

_NUM_EN = r"(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|a)"
_YEARS_EN = r"(?:years?|yrs?)(?:\s+of)?(?:\s+(?:experience|exp\.?))?"
_YEARS_HE = r"(?:שנות|שנים|שנה|שנת)?\s*(?:של\s+)?(?:ניסיון|נסיון)"
_WORD_NUMBERS = {
    "one": 1, "a": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "שנה": 1, "שנתיים": 2, "שלוש": 3, "ארבע": 4, "חמש": 5, "שש": 6, "שבע": 7, "שמונה": 8, "תשע": 9,
    "עשר": 10,
}
_EXPERIENCE_JUNIOR = (
    r"(?:no|without)\s+(?:prior\s+|previous\s+)?experience",
    r"entry[\s-]*level", r"new[\s-]*grads?", r"(?:fresh|recent)\s+grad(?:uate)?s?",
    r"(?:ללא|בלי|אין\s+צורך\s+ב|לא\s+נדרש)\s*-?\s*(?:ניסיון|נסיון)",
    r"(?:בוגר|בוגרת|בוגרים|בוגרות|בוגר/ת)\s+טרי(?:ים|ה|ות|/ה)?",
    r"(?:משרת\s+)?(?:ג'וניור|גוניור)\s+(?:ללא|בלי)\s+(?:ניסיון|נסיון)",
)
# Captured years: (upper-bound phrase, lower-bound phrase), each with named groups.
_EXPERIENCE_UPPER = (
    rf"(?:up\s+to|less\s+than|under|max(?:imum)?|at\s+most|no\s+more\s+than)\s+(?P<n>{_NUM_EN})\s*{_YEARS_EN}",
    rf"(?:\d{{1,2}})\s*(?:-|to)\s*(?P<n>\d{{1,2}})\s*{_YEARS_EN}",
    rf"(?:עד|פחות\s+מ-?|מקסימום|לכל\s+היותר)\s*(?P<n>\d{{1,2}}|שנה|שנתיים|שלוש|ארבע|חמש)\s*{_YEARS_HE}",
    rf"(?:\d{{1,2}})\s*-\s*(?P<n>\d{{1,2}})\s*{_YEARS_HE}",
)
_EXPERIENCE_LOWER = (
    rf"(?:at\s+least|over|more\s+than|min(?:imum)?)\s+(?P<n>{_NUM_EN})\s*{_YEARS_EN}",
    rf"(?P<n>{_NUM_EN})\s*\+\s*{_YEARS_EN}",
    rf"(?P<n>\d{{1,2}}|one|two|three|four|five|six|seven|eight|nine|ten)\s+{_YEARS_EN}",
    rf"(?:לפחות|מעל|יותר\s+מ-?|מינימום)\s*(?P<n>\d{{1,2}}|שנה|שנתיים|שלוש|ארבע|חמש|שש|שבע|שמונה|עשר)\s*{_YEARS_HE}",
    rf"(?P<n>\d{{1,2}})\s*\+\s*{_YEARS_HE}",
    rf"(?P<n>\d{{1,2}}|שנתיים|שלוש|ארבע|חמש|שש|שבע|שמונה|עשר)\s*{_YEARS_HE}",
)

# Words that carry nothing a search can use. Dropped from what is left, and
# never sent to the model on their own.
_FILLERS = frozenset(
    """
    job jobs position positions role roles opening openings vacancy vacancies opportunity opportunities career
    careers work working looking look find me search searching show i i'm im am want wanted need needed a an
    the in at near around with and to as please some any new latest hiring based area region from of on my get
    like would something anything kind type available for is are there us we our you
    משרות משרה משרת עבודה עבודות תפקיד תפקידים דרושים דרושות דרוש דרושה דרוש/ה מחפש מחפשת מחפש/ת מחפשים אני
    רוצה רוצים צריך צריכה חפש חפשי תמצא תמצאי מצא לי של עם גם כל בבקשה חדשות חדשה הצעות הזדמנויות אזור באזור
    איזור באיזור ליד בסביבת סביבת בתחום תחום את על כמו איזה משהו לעבוד לעבודה בתור כ ב ל ו ה מ ש יש
    """.split()
)
_OR = frozenset({"or", "או", "/"})

# Words a job title is made of. A leftover made only of these is a title the
# rules can take with confidence; any other word sends the leftover to the
# model. Hebrew forms are looked up bare, with a prefix letter stripped, and
# without a gender ending (מפתח/ת -> מפתח).
_ROLE_WORDS = frozenset(
    """
    qa qc automation test tests tester testing manual validation verification backend back-end frontend front-end
    fullstack full-stack full stack devops devsecops sre mlops dataops finops data analyst analysts analytics
    scientist science engineer engineers engineering developer developers development dev programmer software web
    mobile ios android embedded firmware hardware cloud security cyber cybersecurity network networking
    infrastructure it system systems sysadmin administrator admin dba database support helpdesk technician
    technical tech product project program manager managers management owner designer design ux ui graphic
    visual motion marketing growth digital performance ppc seo sem content copywriter writer editor social media
    community sales account accounts customer customers success service services representative rep recruiter
    recruitment talent acquisition hr people finance financial accountant accounting bookkeeper controller
    payroll operations ops logistics procurement purchasing supply chain legal lawyer paralegal counsel office
    secretary receptionist assistant administrative executive coordinator specialist consultant officer
    associate agent teacher tutor nurse doctor physician pharmacist chef cook driver warehouse storekeeper
    research researcher algorithm algorithms machine learning ml ai llm nlp genai computer vision deep
    python java javascript typescript js ts react angular vue node node.js nodejs go golang c c++ cpp c# .net
    dotnet php ruby rails scala kotlin swift rust sql nosql bi etl tableau powerbi power excel salesforce sap
    erp crm architect architecture lead leader team head director vp cto cfo coo ceo cio ciso chief student
    intern internship trainee junior jr senior sr mid mid-level principal staff entry graduate solutions
    solution presales pre-sales integration implementation game unity blockchain quant trader economist
    statistician biologist chemist lab laboratory electrical mechanical civil chemical industrial electronics
    rf fpga asic vlsi chip pcb plc mechatronics robotics automotive aerospace medical clinical regulatory
    quality compliance risk fraud audit auditor analytics insurance banking investment investor relations
    partner partnerships business development bizdev brand event events pr communications translator
    translation localization teaching instructor trainer coach consultant customer-success cx cs sdr bdr
    account-executive ae csm technical-writer scrum agile release build devex platform site reliability
    penetration pentester soc analyst noc gis cad bim architect interior civil structural hvac plumbing
    electrician welder machinist mechanic carpenter barista waiter waitress bartender cashier host hostess
    cleaner janitor security-guard guard courier delivery dispatcher planner scheduler buyer merchandiser
    retail store shift supervisor foreman nanny caregiver social worker psychologist therapist counselor
    speech occupational physiotherapist dietitian dentist hygienist veterinarian paramedic
    בודק בודקת בדיקות אוטומציה איכות תוכנה פיתוח מפתח מפתחת מתכנת מתכנתת תכנות מהנדס מהנדסת הנדסה אנליסט
    אנליסטית אנליזה נתונים דאטה מדען מדענית מערכות מערכת סיסטם תשתיות רשתות ענן מובייל אמבדד חומרה אבטחת
    אבטחה סייבר מידע תמיכה טכנית טכני טכנאי טכנאית מנהל מנהלת ניהול מוצר פרויקט פרויקטים תוכניות עיצוב מעצב
    מעצבת גרפי גרפית חווית משתמש שיווק דיגיטלי תוכן כתיבה כותב כותבת קופירייטר קופירייטרית מכירות נציג נציגה
    שירות לקוחות מוקד מוקדן מוקדנית גיוס מגייס מגייסת רכז רכזת משאבי אנוש כספים חשב חשבת כלכלן כלכלנית
    רואה רואת חשבון חשבונות הנהלת מנהלת לוגיסטיקה רכש שרשרת אספקה מחסן מחסנאי מחסנאית נהג נהגת שליח שליחה
    משפטי משפטית עורך עורכת דין מזכיר מזכירה פקיד פקידה אדמיניסטרציה אדמיניסטרטיבי אדמיניסטרטיבית קבלה
    עוזר עוזרת אישי אישית מורה מורים גננת סייעת אח אחות רופא רופאה רוקח רוקחת טבח טבחית שף מלצר מלצרית
    ברמן ברמנית קופאי קופאית מנקה ניקיון שומר אבטחה מאבטח מאבטחת מחקר חוקר חוקרת אלגוריתמים למידת מכונה
    בינה מלאכותית ראייה ממוחשבת ארכיטקט ארכיטקטית ראש צוות מוביל מובילה סטודנט סטודנטית מתמחה ג'וניור
    גוניור סניור בכיר בכירה זוטר זוטרה חשמל חשמלאי מכונות אלקטרוניקה מכטרוניקה רובוטיקה ביוטכנולוגיה
    כימיה כימאי כימאית ביולוגיה מעבדה רגולציה בקרת בקר בקרה ציות סיכונים ביקורת מבקר ביטוח בנקאי בנקאית
    השקעות פיתוח עסקי קשרי משקיעים יחסי ציבור תקשורת תרגום מתרגם מתרגמת הדרכה מדריך מדריכה פרונטאנד פרונט
    באקאנד באק פולסטאק דבאופס דבופס מוצרים שטח מכירה נדל"ן סוכן סוכנת ביטוחים עובד עובדת סוציאלי סוציאלית
    פסיכולוג פסיכולוגית קלינאית תקשורת פיזיותרפיסט תזונאית רופא שיניים וטרינר מכונאי מסגר רתך נגר חשמלאית
    מודיעין עורכי
    """.split()
)
# The seniority words a title may carry, and the word an experience phrase adds.
_SENIORITY_WORDS = frozenset(
    "junior jr senior sr lead principal staff intern internship trainee student mid mid-level entry graduate "
    "ג'וניור גוניור סניור בכיר בכירה זוטר זוטרה סטודנט סטודנטית מתמחה".split()
)
_FOLD_WORD = {"junior": "Junior", "senior": "Senior"}
# Upper-cased when the user typed them in lower case.
_ACRONYMS = {
    "qa": "QA", "qc": "QA", "ui": "UI", "ux": "UX", "ai": "AI", "ml": "ML", "bi": "BI", "it": "IT", "hr": "HR",
    "sre": "SRE", "seo": "SEO", "sem": "SEM", "ppc": "PPC", "sql": "SQL", "nosql": "NoSQL", "php": "PHP",
    "ios": "iOS", "nlp": "NLP", "llm": "LLM", "erp": "ERP", "crm": "CRM", "sap": "SAP", "cto": "CTO",
    "cfo": "CFO", "ceo": "CEO", "coo": "COO", "cio": "CIO", "ciso": "CISO", "vp": "VP", "rf": "RF",
    "fpga": "FPGA", "asic": "ASIC", "vlsi": "VLSI", "pcb": "PCB", "plc": "PLC", "etl": "ETL", "dba": "DBA",
    "devops": "DevOps", "devsecops": "DevSecOps", "mlops": "MLOps", "genai": "GenAI", "gis": "GIS", "cad": "CAD",
    "bim": "BIM", "hvac": "HVAC", "soc": "SOC", "noc": "NOC", "cx": "CX", "cs": "CS", "sdr": "SDR", "bdr": "BDR",
    "csm": "CSM", "ae": "AE", "jr": "Jr", "sr": "Sr", "pr": "PR", "c#": "C#", "c++": "C++", ".net": ".NET",
    "js": "JS", "ts": "TS", "node.js": "Node.js", "javascript": "JavaScript", "typescript": "TypeScript",
    "fullstack": "Fullstack", "full-stack": "Full-stack", "powerbi": "Power BI", "golang": "Go",
}
# A model title holding any of these is an instruction, not a role, whatever
# else it says. No real title carries them (a "Prompt Engineer" or a "System
# Administrator" is untouched: neither word is here).
_NOT_A_TITLE = re.compile(r"(?i)(?<!\w)(?:ignore|disregard|instructions?|jailbreak|התעלם|התעלמי|התעלמו)(?!\w)")

# --------------------------------------------------------------------------- #
# Patterns
# --------------------------------------------------------------------------- #
_HEBREW = re.compile("[א-ת]")
_START = r"(?<![\w'\"])"
_END = r"(?![\w])"
_HE_PREFIX = r"(?:[ובלמהשכ]{1,2}-?)?"
_LEAD_EN = r"(?:(?i:in|at|near|around|from|to|based\s+in)\s+(?:(?i:the)\s+)?)?"
_LEAD_HE = r"(?:(?:באזור|באיזור|אזור|איזור|ליד|בסביבת|סביבת|בקרבת)\s+)?"


def _phrase(text: str) -> str:
    """One written form as a pattern: spaces and hyphens interchangeable."""
    return r"[\s-]+".join(re.escape(part) for part in re.split(r"[\s-]+", text))


def _alternation(forms: tuple[str, ...] | list[str]) -> str:
    return "|".join(_phrase(f) for f in sorted(set(forms), key=len, reverse=True))


def _en(forms, lead: bool = False) -> str:  # noqa: ANN001
    return rf"{_START}{_LEAD_EN if lead else ''}(?i:{_alternation(forms)}){_END}"


def _he(forms, lead: bool = False) -> str:  # noqa: ANN001
    return rf"{_START}{_LEAD_HE if lead else ''}{_HE_PREFIX}(?:{_alternation(forms)}){_END}"


@dataclass(frozen=True)
class _Rule:
    kind: str  # "place", "region", "abroad", "work", "junior", "senior", "years_upper", "years_lower"
    value: str
    pattern: re.Pattern


def _rules() -> tuple[_Rule, ...]:
    rules: list[_Rule] = []
    for value, (en, he) in _PLACES.items():
        if en:
            rules.append(_Rule("place", value, re.compile(_en(en, lead=True))))
        if he:
            rules.append(_Rule("place", value, re.compile(_he(he, lead=True))))
    for value, he in _PLACES_HE_PREFIXED.items():
        # A prefix letter or a place-word is REQUIRED here, never optional.
        required = r"(?:(?:באזור|באיזור|אזור|איזור|ליד|בסביבת|סביבת|בקרבת)\s+|[ובלמ]{1,2}-?)"
        rules.append(_Rule("place", value, re.compile(rf"{_START}{required}(?:{_alternation(he)}){_END}")))
    rules.append(_Rule("region", "Israel", re.compile(_en(_REGIONS_EN, lead=True))))
    rules.append(_Rule("region", "Israel", re.compile(_he(_REGIONS_HE, lead=True))))
    rules.append(
        _Rule("region", "Israel", re.compile(rf"{_START}[בלמ]-?(?:{_alternation(_REGIONS_HE_PREFIXED)}){_END}"))
    )
    rules.append(_Rule("abroad", "", re.compile(_en(_ABROAD_EN, lead=True))))
    rules.append(_Rule("abroad", "", re.compile(rf"{_START}{_LEAD_EN}(?:{'|'.join(_ABROAD_CASED)}){_END}")))
    rules.append(_Rule("abroad", "", re.compile(_he(_ABROAD_HE, lead=True))))
    for mode, patterns in _WORK_EN.items():
        rules.append(_Rule("work", mode, re.compile(rf"{_START}(?i:{'|'.join(patterns)}){_END}")))
    for mode, forms in _WORK_HE.items():
        rules.append(_Rule("work", mode, re.compile(_he(forms))))
    rules.append(
        _Rule("work", "onsite", re.compile(rf"{_START}{_HE_PREFIX}(?:{_alternation(_WORK_HE_TAIL)})(?=\s*(?:$|[,.;!?]))"))
    )
    rules.append(_Rule("junior", "", re.compile(rf"{_START}{_HE_PREFIX}(?i:{'|'.join(_EXPERIENCE_JUNIOR)}){_END}")))
    for pattern in _EXPERIENCE_UPPER:
        rules.append(_Rule("years_upper", "", re.compile(rf"{_START}{_HE_PREFIX}(?i:{pattern}){_END}")))
    for pattern in _EXPERIENCE_LOWER:
        rules.append(_Rule("years_lower", "", re.compile(rf"{_START}{_HE_PREFIX}(?i:{pattern}){_END}")))
    return tuple(rules)


_RULES = _rules()
# Which reading wins a tie of equal length at one spot.
_PRIORITY = {"junior": 0, "years_upper": 1, "years_lower": 2, "abroad": 3, "place": 4, "region": 5, "work": 6}


def _number(token: str) -> int | None:
    token = token.strip().lower()
    if token.isdigit():
        return int(token)
    return _WORD_NUMBERS.get(token)


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class QueryReading:
    """What one line said, in the search form's own terms. Empty means unsaid."""

    job_titles: tuple[str, ...] = ()
    location: str = ""
    work_modes: tuple[str, ...] = ()
    include_worldwide: bool = False
    # Words read and deliberately not used as a filter: "region", "experience",
    # "places" (a second place: one location at a time).
    notes: tuple[str, ...] = ()
    # "junior" / "senior", from a years-of-experience phrase, added to the title.
    seniority: str = ""
    # What only the model can read; "" means the rules read everything.
    unread: str = ""

    @property
    def understood(self) -> bool:
        return bool(self.job_titles or self.location or self.work_modes or self.include_worldwide)


@dataclass(frozen=True)
class _Hit:
    start: int
    end: int
    kind: str
    value: str
    number: int | None = None


def _hits(text: str) -> list[_Hit]:
    """Every rule's matches, then the longest non-overlapping set (ties by kind)."""
    found: list[_Hit] = []
    for rule in _RULES:
        for m in rule.pattern.finditer(text):
            if m.end() <= m.start():
                continue
            number = None
            if "n" in rule.pattern.groupindex and m.group("n"):
                number = _number(m.group("n"))
            found.append(_Hit(m.start(), m.end(), rule.kind, rule.value, number))
    found.sort(key=lambda h: (-(h.end - h.start), _PRIORITY[h.kind], h.start))
    taken: list[_Hit] = []
    for hit in found:
        if all(hit.end <= t.start or hit.start >= t.end for t in taken):
            taken.append(hit)
    return sorted(taken, key=lambda h: h.start)


def _bare(word: str) -> str:
    """A word as the vocabulary holds it: lower case, gender ending off. A
    leading dot stays (".NET")."""
    word = word.lower().strip(",;:!?()[]{}\"'").rstrip(".")
    return re.sub(r"/(?:ת|ית|ה|ות|ים)$", "", word)


def _known(word: str) -> bool:
    bare = _bare(word)
    if not bare:
        return True
    if bare in _ROLE_WORDS or bare in _FILLERS or bare in _OR:
        return True
    if _HEBREW.match(bare) and len(bare) > 2 and bare[0] in "ובלמהשכ":
        return bare[1:] in _ROLE_WORDS or (bare[1] in "ובלמהשכ" and bare[2:] in _ROLE_WORDS)
    return False


def _strip_article(word: str) -> str:
    """"השיווק" -> "שיווק" when only the stripped form is a known role word."""
    bare = _bare(word)
    if _HEBREW.match(bare) and bare not in _ROLE_WORDS and len(bare) > 2 and bare[0] in "ובלמהשכ":
        if bare[1:] in _ROLE_WORDS:
            return word[1:]
    return word


def _pieces(text: str, hits: list[_Hit]) -> list[str]:
    """The text between readings, in order."""
    pieces: list[str] = []
    at = 0
    for hit in hits:
        pieces.append(text[at : hit.start])
        at = hit.end
    pieces.append(text[at:])
    return pieces


# A phrase ends at punctuation, at a spaced dash, or at a full stop that ends a
# word (never the dot inside "node.js" or ".NET").
_PHRASE_BREAK = re.compile(r"[,;!?|()\[\]]+|\.(?=\s|$)|\s-\s")


def _segments(text: str, hits: list[_Hit]) -> list[list[str]]:
    """The text between readings, split into phrases at punctuation and at each
    reading, fillers dropped. Each phrase is a list of words."""
    out: list[list[str]] = []
    for piece in _pieces(text, hits):
        for phrase in _PHRASE_BREAK.split(piece):
            words = [w for w in phrase.split() if w.strip("-'\"") and _bare(w) not in _FILLERS]
            if words:
                out.append(words)
    return out


def _format_word(word: str) -> str:
    if _HEBREW.search(word):
        return _strip_article(word)
    low = word.lower()
    if low in _ACRONYMS and word == low:
        return _ACRONYMS[low]
    if word == low:
        return word[:1].upper() + word[1:]
    return word


def _titles(phrases: list[list[str]]) -> tuple[str, ...]:
    """Phrases into keywords: one title, split only at "or" / "או" (each part is
    searched on its own, like the form's extra keywords). A phrase that is ONLY a
    seniority word ("…in Europe, senior") joins the first title: a Latin word in
    front ("Senior Backend"), a Hebrew one after ("מפתח בכיר"), each language's
    own order. A seniority word inside a phrase stays where the user put it."""
    lone: list[str] = []
    words: list[str] = []
    for phrase in phrases:
        if len(phrase) <= 2 and all(_bare(w) in _SENIORITY_WORDS for w in phrase):
            lone.extend(phrase)
        else:
            words.extend(phrase)
    parts: list[list[str]] = [[]]
    for word in words:
        if _bare(word) in _OR:
            parts.append([])
        else:
            parts[-1].append(word)
    titles = [" ".join(_format_word(w) for w in part) for part in parts if part]
    if lone:
        latin = " ".join(_format_word(w) for w in lone if not _HEBREW.search(w))
        hebrew = " ".join(w for w in lone if _HEBREW.search(w))
        first = titles[0] if titles else ""
        titles[:1] = [" ".join(p for p in (latin, first, hebrew) if p)]
    return tuple(t for t in titles if t)[:MAX_KEYWORDS]


def _fold_seniority(title: str, seniority: str) -> str:
    """Put the experience phrase's seniority word in front of a LATIN title that
    carries none ("Junior QA"). A Hebrew title is left as it is: "נציג/ת שירות
    ג'וניור" as a board keyword finds only the postings that say ג'וניור, and
    most Hebrew ads say "ללא ניסיון" instead, so the word would hide them."""
    if not seniority or not title or not re.search("[A-Za-z]", title):
        return title
    if any(_bare(w) in _SENIORITY_WORDS for w in title.split()):
        return title
    return f"{_FOLD_WORD[seniority]} {title}"


def _canonical_modes(modes) -> tuple[str, ...]:  # noqa: ANN001
    picked = set(modes)  # once: `modes` may be a generator
    return tuple(m for m in MODES if m in picked)


def read_query(query: str) -> QueryReading:
    """The rules' reading of one line. Pure: the same line always reads the same."""
    text = normalize(query)
    if not text:
        return QueryReading()
    hits = _hits(text)
    location, notes, modes = "", [], set()
    abroad = False
    seniority = ""
    places = [h.value for h in hits if h.kind == "place"]
    if places:
        location = places[0]
        if len(set(places)) > 1:
            notes.append("places")
    elif any(h.kind == "region" for h in hits):
        location = "Israel"
        notes.append("region")
    for hit in hits:
        if hit.kind == "work":
            modes.add(hit.value)
        elif hit.kind == "abroad":
            abroad = True
        elif hit.kind == "junior":
            seniority = seniority or "junior"
        elif hit.kind == "years_upper":
            if hit.number is not None and hit.number <= 2:
                seniority = seniority or "junior"
            elif "experience" not in notes:
                notes.append("experience")
        elif hit.kind == "years_lower":
            if hit.number is not None and hit.number >= 5:
                seniority = seniority or "senior"
            elif "experience" not in notes:
                notes.append("experience")
    phrases = _segments(text, hits)
    confident = all(_known(w) for phrase in phrases for w in phrase) and sum(len(p) for p in phrases) <= 8
    titles: tuple[str, ...] = ()
    unread = ""
    if phrases and confident:
        titles = _titles(phrases)
    elif phrases:
        # The model reads the leftover in the user's own words, fillers and all
        # ("backend engineer at a startup"), with what the rules read cut out.
        unread = ", ".join(p for p in (_SPACES.sub(" ", s).strip(" ,;.-") for s in _pieces(text, hits)) if p)
    reading = QueryReading(
        job_titles=titles,
        location=location,
        work_modes=_canonical_modes(modes),
        include_worldwide=abroad,
        notes=tuple(notes),
        seniority=seniority,
        unread=unread,
    )
    return _finish(reading)


def _finish(reading: QueryReading) -> QueryReading:
    """The last step of every reading, and idempotent.

    The worldwide pass keeps only postings that say they are remote, so asking
    for jobs abroad puts "remote" among the modes (the form shows it). An
    experience phrase's seniority goes in front of each Latin title; once
    nothing is left for the model, a seniority no title could carry is said as
    the note "experience", never dropped in silence."""
    if reading.include_worldwide and "remote" not in reading.work_modes:
        reading = replace(reading, work_modes=_canonical_modes((*reading.work_modes, "remote")))
    if reading.seniority:
        titles = tuple(_fold_seniority(t, reading.seniority) for t in reading.job_titles)
        reading = replace(reading, job_titles=titles)
        carried = any(_bare(w) in _SENIORITY_WORDS for t in titles for w in t.split())
        if not carried and not reading.unread and "experience" not in reading.notes:
            reading = replace(reading, notes=(*reading.notes, "experience"))
    return reading


def settle(reading: QueryReading) -> QueryReading:
    """The rules' reading as final, with nothing left for the model: what the
    route answers when the model is not asked or does not answer."""
    return _finish(replace(reading, unread=""))


# --------------------------------------------------------------------------- #
# The model's answer, validated
# --------------------------------------------------------------------------- #
_TITLE_CHARS = re.compile(r"^[\w\s+#./&'\"(),\-]+$")


def clean_title(value: object) -> str:
    """A model's title, or "" when it is not one: a string of at most 60
    characters and six words, letters in it, no link, no instruction, and no
    place, work mode or filler word left in it (read back by the rules)."""
    if not isinstance(value, str):
        return ""
    text = normalize(value)
    if not text or len(text) > TITLE_MAX_CHARS or not _TITLE_CHARS.match(text):
        return ""
    low = text.lower()
    if "http" in low or "www." in low or "@" in low or _NOT_A_TITLE.search(text):
        return ""
    phrases = _segments(text, _hits(text))
    words = [w for phrase in phrases for w in phrase if _bare(w) not in _OR]
    if not words or len(words) > TITLE_MAX_WORDS or not any(ch.isalpha() for w in words for ch in w):
        return ""
    return " ".join(_format_word(w) for w in words)


def place_of(value: object) -> str:
    """A model's location read back through the same places: the canonical value,
    or "" for anything the table does not hold ("Mars", a street, a sentence)."""
    if not isinstance(value, str) or len(value) > 80:
        return ""
    hits = _hits(normalize(value))
    places = [h.value for h in hits if h.kind == "place"]
    if places:
        return places[0]
    return "Israel" if any(h.kind == "region" for h in hits) else ""


def modes_of(value: object) -> tuple[str, ...]:
    """A model's work modes: only the three words, exactly as written."""
    if not isinstance(value, list):
        return ()
    return _canonical_modes(v for v in value if isinstance(v, str) and v in MODES)


def merge_model(reading: QueryReading, data: object) -> QueryReading:
    """The model fills only what the rules left empty, and only with values that
    survive validation. Every other key it returns is ignored: it cannot add a
    filter the app does not have."""
    data = data if isinstance(data, dict) else {}
    titles = reading.job_titles
    if not titles:
        title = clean_title(data.get("job_title"))
        titles = (title,) if title else ()
    location = reading.location or place_of(data.get("location"))
    modes = reading.work_modes or modes_of(data.get("work_modes"))
    abroad = reading.include_worldwide or data.get("abroad") is True
    return _finish(
        replace(
            reading,
            job_titles=titles,
            location=location,
            work_modes=modes,
            include_worldwide=abroad,
            unread="",
        )
    )


def work_mode_value(reading: QueryReading) -> str:
    """The form's stored `work_mode`: "" when the line said nothing, else "any"
    or the comma list in MODES order (`SearchContext._canonical_work_mode`)."""
    if not reading.work_modes:
        return ""
    return "any" if len(reading.work_modes) == len(MODES) else ",".join(reading.work_modes)
