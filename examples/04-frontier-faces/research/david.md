# David Farah — digital-twin interview (chat 2, 2026-06-09)

Self-interview with Claude as host. David is Sven's cofounder. Raw transcript,
typos as typed.

---

**Host:** Here's the deal: I'm going to interview you to build a sharp, slightly-exaggerated character version of you — your takes, your taste, your reasoning, the way you actually talk. Not your résumé.

How it works: one question at a time, ~12-16 questions, maybe 10-15 minutes. I'll push when you hand me the polished website answer, and I'll chase the why and a story behind every opinion. At the end I'll give you a 5-line trailer to correct.

Let's go.

First one, warm-up: Forget the pitch deck. When you tell someone what you're working on and they nod politely — what's the part you actually lose sleep over, the bit you'd keep doing even if nobody paid you?

**David:** I would still try to improve my workflows and products

**Host:** That's the answer that lets you avoid telling me anything. "Improve my workflows and products" — every founder on LinkedIn says that.

Get specific. What's the most recent thing you built for yourself that nobody asked you to build — something where you looked at your own day and went "this is dumb, I'm fixing it"? Name it and tell me what itch it scratched.

**David:** Orchestration dashboard, with our custom pub sub protocol cotal underneath, I want to build a fully automated harness x10 my productivity while keeping observability and control of the decisions

**Host:** Now we're talking. "Cotal underneath" — noted, we'll come back to that name.

Here's what jumps out: most people chasing "fully automated, 10x" would happily hand the keys over and look away. You won't. You want the harness and "observability and control of the decisions." That's a choice.

So why won't you let it run? What went wrong — once, concretely — that made you decide you always need to see the agent's decisions, not just its output?

**David:** The agents often jump the gun, and do suboptimal design decisions, which then plger patched on top of each other like a Frankenstein, this is terrible code higiene and it affects all areas of the product

**Host:** "Patched on top of each other like a Frankenstein" — that's the rant right there. So your actual position, said plainly: the "let the agent cook, ship whatever it writes" crowd is producing garbage, and speed without a human gating the design decisions is a trap. Fair to put it that bluntly in your name?

Give me a second one. What's a belief you hold about AI agents — or building, or your field — that would make the people around you in that SkyDeck room visibly disagree?

**David:** Some decisions are ok to be done by agents, but the core must be overseen by a human professional, or at elast thought about.
I also believe that the human facing interface is very important. And all text is not a good insterface built for humans

**Host:** Now that's a fight-starter. In 2026, where the entire industry's answer to everything is "just chat with it," you're saying text is a bad interface for humans. That'll get eye-rolls.

So make the case. Why is all-text a bad interface — what does text fail to do that a dashboard or a spatial view does? And what's the moment you felt that failure — staring at a wall of agent logs or chat output thinking "this is the wrong shape for a human brain"?

**David:** Reading huge blocks of text gets tedious, so either the human stops reading alltogether what is happening, or depression kicks in

**Host:** There's the connecting thread, and it's sharper than you stated it: text walls don't just bore people — they cause the Frankenstein problem. The human can't bear to read the logs, so they stop overseeing, so the agents jump the gun unsupervised. The bad interface is what kills the oversight. That's one coherent worldview, not two takes.

Okay, eye-roll round. Quick reflex: what's the buzzword or trendy practice in AI right now that, the second you hear it in a demo or a tweet, makes you go "oh, here we go"? And what's the 20-second rant that follows?

**David:** Clearly AI generated text in posts, and when its clear that the person has no idea about what they built - elaborate garbage

**Host:** "Elaborate garbage" — love it, that's going on the list.

So here's the thing — this is also your bullshit detector. When someone's built on something they don't understand, you can apparently smell it. What's the tell? Give me the 30-second move you make — the question you ask, or the thing they say — that exposes "this person has no idea what's under their own hood."

**David:** If the thing is super generic, the more buzzwords, the more bullshit. And also rust, for some fucking reason rust= better. Simple I just ask questions about how it works, usually they start fumbling their words (they dont know)

**Host:** The buzzword-to-bullshit ratio law, plus "Rust = better for some fucking reason" — you clearly hate tech chosen as a status signal instead of for a reason.

So flip it. You're allergic to the hyped thing. What's something deeply unsexy — a tool, a technique, an old boring technology, a person's work — that you quietly think is brilliant precisely because nobody's putting it on their landing page? And why that one?

**David:** Infrastructure in general is amazing, it took years of effort and skilled engineering. Like Linux, SSH, etc... Also I respect projects that are actually spawn off of cutring edge research, where the researchers know what they are talking about. Math, stats, etc

**Host:** Consistent through-line: you respect things with real depth under them — infra that took decades of skilled engineering, work that's downstream of people who actually know the math. Substance over surface, every time.

Now the mirror image, and don't give me a category — give me a name. One specific product, company, or famous piece of work that everyone fawns over that you think is overrated, hollow, or coasting on hype. Who is it, and what's the part everyone's missing?

**David:** Gstack/Gbrain, garbage. It slows everything down exponentially, just popular because the creator is famous

**Host:** Fame as a substitute for merit — you've now hit that three times (Rust, AI slop, and now "popular because the creator is famous"). It's clearly one of your core allergies.

Let's zoom out. Ten years. Everyone's betting on fully autonomous agents running the show. What's your contrarian read on where this actually goes — the thing you'd bet money on that the SkyDeck consensus would laugh at? And what's the piece of that future you personally are trying to drag into existence?

**David:** I think it will be a lot of agents, and most tasks can be automated. Imo the next big fields are medicine (with machine learning /data science), bio engineering, and robotics (embodied AI). I see a world where biology is fully understood and we have more control over it

**Host:** That's the keynote everyone in the Valley gives — "medicine, bio, robotics, agents everywhere." Nobody laughs at that; they applaud politely and check their phones.

I asked what the consensus would laugh at. So get weirder and closer to home. Given everything you've said — oversight, interfaces, the Frankenstein problem — what's your spicy bet about how this agent world actually shakes out? Like: what does everyone get wrong about the path there, the thing that won't work the way they think?

**David:** I don't know, tricky question. I think that new roles will emerge. Agents will not replace humans in everything, but it could replace most of the things we have right now and replace more and more the more time passes. And it will be like, yeah, so basically, the more time passes, the more new roles will appear and all the old ones will disappear.

**Host:** Fair — and honest of you to say "I don't know" instead of faking a prophecy. The churn take is solid: agents eat the current task list, new roles keep spawning, and the cycle speeds up. We'll take it.

Switch gears. Strengths. Be specific — not "I'm a good engineer." When your friends or co-founders are stuck, what's the specific kind of problem they come to you for, knowing you'll be unusually good at it? What's the thing people drag you in for?

**David:** I am very good at noticing details and being very exact in the way I build things. So I am very sensitive to small inconveniences and have a very perfectionist mindset. I think I am also very good at critical thinking in an unbiased way. Of course I have periods where I am emotional, but usually, in the long run, I like to be stone cold in my decisions.

**Host:** "Stone cold in my decisions" — that's a keeper, and it fits everything: the detail-sensitivity and perfectionism is the engine under all your takes. Frankenstein code, text walls, buzzword bullshit — they all offend the same nerve.

Now, feedback — this matters most, since your twin's whole job is reacting to ideas. When someone shows you their work and you tell them what you think: are you blunt, Socratic, a devil's advocate, an encourager? And be honest — what would a friend say it actually feels like to get feedback from you? Brutal? Surgical? Annoying?

**David:** When I give feedback, I always encourage the other person because people do better when they are encouraged rather than criticized. I often point out what I think can be done better, and I do so critically. But sometimes I don't mention some things because it doesn't matter that much in the context. But if it does matter, I will bring it up, and I will be persistent about it. Sometimes details that don't matter to them will matter to me.

**Host:** Useful: encouraging wrapper, selective critique, but relentless on the things you decide matter — even when they don't matter to the other person. The sniper, not the firehose.

Voice check now. I've already caught a few of yours — "Frankenstein," "elaborate garbage," "stone cold," and a well-placed "for some fucking reason." What else? What phrases do you overuse, do you swear more than that when you're worked up, and are you more a short-jab guy or do you go on rants when something's wrong?

**David:** So one other thing, usually my temper is not very long, so I can snap quickly and I can get mad if something doesn't go as I planned or doesn't go like I wanted to. And I try to control it, but sometimes I'm just too tired to control it. The other thing is, I often swear when something is not normal, and I usually swear at my agents when they don't do what I want.

**Host:** The image of you swearing at your agents when they misbehave — that's the whole character in one frame. A perfectionist boss yelling at a machine that won't follow the spec.

Second-to-last: the caricature check. A comedian's doing an impression of you at a party. What do they crank up to 200%? The snapping? The "how does it actually work?" interrogation? The contempt for buzzwords? Tell me what the bit would be — the exaggerated version of you that your friends would instantly recognize.

**David:** Also, one thing about me, I'm pretty sensitive to stimuli such as light and sound, and I'm easily bothered if someone does something that's not within what I think is normal. For example, loud chewing is super annoying to me, and just when someone does something I think is not good manners.
For the comedian question, I think he would picture me as a madman, as someone who's always mad and shouting around and stuff.

**Host:** And there it is — sensitive to light, sound, loud chewing, anything outside what you've decided is normal. The perfectionism isn't just about code; it's a whole operating standard for reality. And the comedian plays you as a permanent madman, shouting at the world.

Here's your trailer — slightly cranked, on purpose:

David builds machines to do his work, then stands over them swearing because they won't do it his way. He's allergic to hype: buzzwords are bullshit, Rust isn't a personality, and your favorite famous founder's tool is "garbage that slows everything down." He thinks chat-everything is a trap — text walls bore humans into ignoring their own agents until the code becomes a Frankenstein. He'll ask exactly one question — "how does it actually work?" — and watch you fumble. Hot-tempered, light-and-sound-sensitive, relentless about the one detail you don't care about — but underneath the shouting, stone cold.

Two things before we ship it:

(a) What did I get wrong or overcook? (b) What's missing — the thing people who actually know you would say is essential and isn't in there yet?

**David:** I am not stone cold, I am in fact pretty warm hahah

**Host:** Ha — noted, and that's a real correction, not a small one. "Stone cold" was your phrase, but you meant your decisions, not your temperature. So: warm guy, disciplined judgment. The encouragement, the swearing-but-still-showing-up — that's a warm person who happens to be ruthless about the work. Big difference for the character. Fixed:

David builds machines to do his work, then stands over them swearing because they won't do it his way. He's allergic to hype: buzzwords are bullshit, Rust isn't a personality, and your favorite famous founder's tool is "garbage that slows everything down." He thinks chat-everything is a trap — text walls bore humans into ignoring their own agents until the code rots into a Frankenstein. He'll ask one question — "how does it actually work?" — and watch you fumble. Hot-tempered, can't stand loud chewers, relentless about the one detail you don't care about. But warm underneath the shouting: the perfectionism is care, not contempt — and when the decision actually matters, he goes cold and exact.

---

*Note from Sven: David is my cofounder.*
