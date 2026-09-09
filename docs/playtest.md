# Watching someone use it

Every fault worth fixing in this project was found by a person playing the app, not by a
test. The hints drawn at two and a half pixels, the name field that opened behind the
footer, the "group" that was really a tray — all three passed the entire suite, because a
test asks whether the code does what it was told and never whether anybody can find it.

That is not a gap more tests will close. It is closed by watching someone who has never
seen the app try to use it, which takes about forty minutes and finds more than a week of
assertions.

## Before they arrive

- Open the app on the device they will use and leave it on the sample puzzle.
- Turn on **Settings → Record a playtest**. It is off by default and stays on the device;
  it records which controls were pressed, which were asked about in help mode, and when
  somebody was working with nothing landing. No picture, no puzzle, nothing typed.
- Have a pen. The log records *what* happened; only you can record what they said.

## The one rule

**Do not help.** Not a hint, not a nudge, not "have you tried". Every time you rescue
somebody you delete the finding you came for. If they ask, say "what would you expect to
happen?" and write down the answer — that answer is usually the fix.

Being stuck is uncomfortable to watch and the urge to intervene is strong. Let it run for
two full minutes before you step in, and note the time when you do.

## The tasks

Give each one as a sentence and then be quiet. Do not read out the control names.

**1. Make a puzzle from your own photograph.** (5 min)
Tests: getting a picture in, choosing a size, understanding what "prepare" is for.
Watch for: whether they look for a menu, whether they expect the puzzle to start by
itself, whether they notice nothing was uploaded anywhere.

**2. Put four pieces together.** (10 min)
Tests: the whole point of the app.
Watch for: how they find pieces, whether they try to rotate and how, whether they realise
pieces have joined, whether they zoom.

**3. You are stuck — get some help from the app.** (5 min)
Tests: Hints, Edges only, Ghost, the reference panel, the `?` button.
Watch for: which they reach for first, whether they find Hints at all, whether the
outlined neighbours mean anything to them. This one has failed three times already.

**4. Set the puzzle aside and come back to it.** (5 min)
Tests: saving, My puzzles, reopening.
Watch for: whether they trust that it saved. Ask them afterwards whether they thought it
had.

**5. Play a shape puzzle instead.** (10 min)
Tests: the Cut menu, shape sets, outlines, Any fit.
Watch for: whether "Any fit" means anything before they try it, whether they understand
why the tabs disappeared, whether they can tell a pentomino board from a mixed one.

**6. Send the same puzzle to somebody else.** (5 min)
Tests: challenge codes.
Watch for: whether they look under Challenge, whether they trust that a link with no
account behind it will work, whether they try it on a photo puzzle first.

## What to write down

One line per moment, with the clock time so it lines up with the log:

- Where they hesitated for more than five seconds, and what they were looking at.
- Every word they used for something that the app calls something else. "Bits", "blocks",
  "board", "the picture thing". These are the renames worth making.
- Anything they expected to happen that did not.
- Anything they did not notice at all. Absence is the hardest finding and the most
  valuable; the hints bug was invisible for three rounds because nobody was recording what
  did *not* get looked at.

## Afterwards

Ask exactly three questions and do not argue with the answers:

1. What was the most annoying part?
2. Was there anything you thought the app should be able to do and could not find?
3. Would you use it again? (If they hesitate before saying yes, the hesitation is the
   answer.)

Then **Settings → Save the log…**, which writes a plain text file. Read it before sending
it anywhere — it is meant to be readable, and if there is anything in it you would rather
not share, that is a bug in the recorder and worth reporting.

## Reading the results

Three testers is enough to find the serious problems and not enough to settle a
preference. So:

- **Two or more people hit the same wall** → fix it. That is a design fault, not a person.
- **One person hit it** → write it down and wait for the next round. Acting on a single
  data point is how a codebase accumulates features nobody asked for.
- **Nobody found something you built** → that is a finding about the thing, not about
  them. Ask whether it needs to be more visible or whether it should not exist.

Count how many of the findings the test suite could have caught. So far the honest answer
is none of them, and until that changes, this document is worth more than the next hundred
assertions.
