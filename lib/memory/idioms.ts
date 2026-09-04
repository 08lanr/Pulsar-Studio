// The register guide: Chinese set phrases, forms of address and short-drama
// beats that have no clean English equivalent, each with the ways an American
// series actually says it and a one-line note on register. Authored by Pulsar
// (house authority, second only to producer-approved lines). Retrieval is
// exact substring containment against the scene's source lines — high
// precision, no false friends — so the guide can be quoted with confidence.
//
// Add entries freely; keep `en` to 1-4 options ordered most-common first and
// `note` to one sentence about WHEN each option fits. Never a plot fact.

export type IdiomEntry = {
  /** Every surface form that should trigger the entry. */
  zh: string[];
  /** American options, most common first. */
  en: string[];
  /** Register / usage note for the adapter (English). */
  note: string;
};

export const IDIOMS: IdiomEntry[] = [
  // ---- courtesy & small talk -------------------------------------------------
  { zh: ["久仰", "久仰大名"], en: ["I've heard a lot about you", "Heard so much about you", "It's an honor"], note: "Business first-meeting formula; 'long admired' is textbook — Americans say they've heard about you." },
  { zh: ["不好意思"], en: ["Sorry", "Excuse me", "Sorry about that", "My bad"], note: "Apology-lite; 'sorry' for lateness or bumping, 'excuse me' when interrupting, 'my bad' only for casual peers." },
  { zh: ["麻烦你", "麻烦您"], en: ["Could you…", "Would you mind…", "Do me a favor"], note: "Softener before a request; render as the request itself, not 'trouble you'." },
  { zh: ["辛苦了", "辛苦你了", "辛苦您了"], en: ["Thanks for this", "Appreciate it", "Good work", "Long day, huh?"], note: "No English equivalent; pick by relationship — boss to staff 'good work', peer 'appreciate it', family 'long day'." },
  { zh: ["拜托", "拜托了"], en: ["Please", "I'm begging you", "Come on"], note: "Pleading 'please' when serious; 'come on' when exasperated." },
  { zh: ["打扰了", "打扰一下"], en: ["Sorry to interrupt", "Excuse me", "Got a minute?"], note: "Entering or interrupting; never 'disturb'." },
  { zh: ["失陪", "失陪一下"], en: ["Excuse me a moment", "I'll be right back", "If you'll excuse me"], note: "Leaving a conversation politely." },
  { zh: ["请吧", "请"], en: ["After you", "Go ahead", "Please", "This way"], note: "When ushering someone through a door 'after you' / 'this way'; when yielding a turn 'go ahead'." },
  { zh: ["慢走"], en: ["Take care", "Drive safe", "See you"], note: "Farewell to a departing guest; never 'walk slowly'." },
  { zh: ["多谢", "谢了", "谢谢你", "谢谢您"], en: ["Thanks", "Thank you", "Thanks a lot"], note: "'Thank you' for elders and formal settings; 'thanks' otherwise." },
  { zh: ["别客气", "不客气", "不用谢"], en: ["Don't mention it", "Of course", "Anytime", "You're welcome"], note: "'Of course' and 'anytime' are the natural spoken replies; 'you're welcome' is slightly formal." },
  { zh: ["没事", "没事儿", "没关系"], en: ["It's fine", "No worries", "I'm okay", "Don't worry about it"], note: "'I'm okay' when asked about oneself; 'no worries' / 'it's fine' when forgiving." },
  { zh: ["请多指教", "多多指教"], en: ["Looking forward to working with you", "I'll be counting on you"], note: "Formula with no English twin; state the relationship it opens." },
  { zh: ["幸会"], en: ["Pleasure", "Nice to meet you", "Good to finally meet you"], note: "'Good to finally meet you' when the name was known beforehand." },
  { zh: ["随便", "随你", "随你便"], en: ["Whatever", "Up to you", "Your call", "Suit yourself"], note: "'Whatever' is dismissive; 'up to you' / 'your call' are neutral; 'suit yourself' is a cold concession." },

  // ---- acknowledgement & agreement -----------------------------------------
  { zh: ["知道了", "我知道了"], en: ["Got it", "I know", "Okay", "Noted"], note: "'Got it' when receiving an instruction; 'I know' when brushing off a reminder (mildly annoyed)." },
  { zh: ["明白", "明白了", "我明白了"], en: ["Understood", "I get it", "I see", "Yes, sir"], note: "'Understood' / 'yes, sir' to a superior; 'I get it' among equals; 'I see' when a realization lands." },
  { zh: ["好的", "好", "行", "成"], en: ["Okay", "Sure", "Fine", "Deal"], note: "'Fine' carries reluctance; 'deal' closes a negotiation." },
  { zh: ["是", "是的"], en: ["Yes", "Yes, sir", "I am", "That's right"], note: "As a reply to a question of identity ('你就是X?') 'I am' beats 'yes'." },
  { zh: ["是吗", "真的吗", "真的假的"], en: ["Really?", "Is that so?", "Was it?", "You sure?"], note: "Echo the verb of the previous line where possible ('Was it?', 'Did he?')." },
  { zh: ["算了", "算了吧"], en: ["Forget it", "Never mind", "Let it go", "Drop it"], note: "'Forget it' when giving up on a request; 'let it go' when advising someone else." },
  { zh: ["得了", "得了吧", "少来"], en: ["Come on", "Oh, please", "Give me a break", "Cut it out"], note: "Disbelieving brush-off; 'oh, please' is sharper." },
  { zh: ["一言为定"], en: ["Deal", "It's a deal", "You've got yourself a deal", "Promise?"], note: "Sealing an agreement; 'promise?' when said as a question." },
  { zh: ["说定了"], en: ["It's settled", "Deal", "Then it's a date"], note: "'Then it's a date' when the plan is a meeting." },
  { zh: ["无所谓"], en: ["I don't care", "Doesn't matter", "Either way"], note: "'I don't care' reads hostile in English; use 'either way' for genuine indifference." },
  { zh: ["也不是不行", "不是不行"], en: ["I could…", "That's not a no", "It's doable"], note: "Grudging assent by double negative; English says it straight." },
  { zh: ["就这样吧", "就这样"], en: ["That's it, then", "Let's leave it there", "So be it", "That's that"], note: "Closing a discussion; 'so be it' when resigned." },
  { zh: ["到此为止"], en: ["We're done here", "That's the end of it", "This stops now"], note: "Ending a relationship or argument; 'we're done here' is the sharpest." },

  // ---- confrontation beats -------------------------------------------------
  { zh: ["你什么意思", "什么意思"], en: ["What's that supposed to mean?", "Meaning what?", "What are you saying?"], note: "Challenge, not a request for definition." },
  { zh: ["你给我站住", "站住"], en: ["Stop right there", "Don't you walk away from me", "Hey! Stop"], note: "'Don't you walk away from me' when the other person is leaving mid-argument." },
  { zh: ["你算什么东西", "你是什么东西"], en: ["Who do you think you are?", "You're nobody", "Who the hell are you?"], note: "Status insult; never 'what thing are you'." },
  { zh: ["你凭什么", "凭什么"], en: ["Who gave you the right?", "Says who?", "What gives you the right?", "Why should I?"], note: "'Why should I?' when refusing an order; 'says who?' when disputing authority." },
  { zh: ["滚", "滚开", "滚出去"], en: ["Get out", "Get lost", "Get out of my sight"], note: "'Get out' fits nearly every case; 'get lost' is contemptuous." },
  { zh: ["闭嘴", "住口"], en: ["Shut up", "Not another word", "Enough"], note: "'Not another word' for a superior or parent; 'shut up' between peers." },
  { zh: ["够了"], en: ["Enough", "That's enough", "Stop it"], note: "Short, cuts the other person off." },
  { zh: ["放手", "放开我"], en: ["Let go", "Let go of me", "Get your hands off me"], note: "Physical; 'get your hands off me' is the angriest." },
  { zh: ["别闹", "别闹了"], en: ["Stop it", "Quit it", "Knock it off", "Don't be like this"], note: "Playful 'quit it'; serious 'don't be like this'." },
  { zh: ["我警告你"], en: ["I'm warning you", "Don't push me", "Last warning"], note: "Threat register; short." },
  { zh: ["你敢", "你敢！", "你敢试试"], en: ["Don't you dare", "Try me", "You wouldn't"], note: "'Try me' when calling a bluff; 'you wouldn't' when in disbelief." },
  { zh: ["怎么回事", "这是怎么回事"], en: ["What's going on?", "What happened?", "What is this?"], note: "'What is this?' when confronted with evidence." },
  { zh: ["什么情况", "搞什么"], en: ["What's going on?", "What the hell?", "What is this?"], note: "Casual confusion; 'what the hell' for shock." },
  { zh: ["开什么玩笑", "你开玩笑吧"], en: ["You're kidding", "Are you serious?", "You can't be serious", "That's a joke, right?"], note: "Disbelief, not about jokes." },
  { zh: ["不可能", "怎么可能"], en: ["No way", "That's impossible", "It can't be", "How?"], note: "'No way' is the natural first reaction; 'it can't be' when shaken." },
  { zh: ["没门", "想都别想"], en: ["No way", "Not a chance", "Forget it", "Over my dead body"], note: "Flat refusal; 'over my dead body' only for high stakes." },
  { zh: ["少废话", "别废话"], en: ["Save it", "Cut the crap", "Skip it", "Spare me"], note: "'Save it' is clean and sharp; 'cut the crap' is vulgar-casual." },
  { zh: ["不关你的事", "跟你没关系", "关你什么事"], en: ["None of your business", "Stay out of it", "That's not your concern"], note: "'That's not your concern' for a formal or superior speaker." },
  { zh: ["你想多了"], en: ["You're overthinking it", "It's not what you think", "Don't read into it"], note: "Deflection; 'it's not what you think' when caught." },
  { zh: ["我没事", "我没事儿"], en: ["I'm fine", "I'm okay", "It's nothing"], note: "Brave-face line; 'it's nothing' when hiding pain." },
  { zh: ["别管我", "不用管我"], en: ["Leave me alone", "Don't worry about me", "I've got it"], note: "'Leave me alone' when hurt; 'don't worry about me' when deflecting care." },
  { zh: ["我们完了", "我们结束了"], en: ["We're done", "We're over", "It's over"], note: "Break-up line; 'we're done' also works for partnerships." },
  { zh: ["你会后悔的", "你会后悔"], en: ["You'll regret this", "You'll be sorry", "Don't say I didn't warn you"], note: "Threat; 'you'll be sorry' is more personal." },
  { zh: ["给你个机会", "再给你一次机会"], en: ["I'll give you one chance", "Last chance", "One more chance"], note: "Ultimatum register." },
  { zh: ["看着办", "你看着办"], en: ["Figure it out", "Handle it", "Your call", "Do what you have to"], note: "Boss delegating with menace: 'handle it'." },
  { zh: ["有话直说", "直说"], en: ["Just say it", "Out with it", "Spit it out", "Say what you mean"], note: "'Spit it out' is impatient; 'just say it' neutral." },
  { zh: ["说重点", "别绕圈子", "别兜圈子"], en: ["Get to the point", "Stop stalling", "Cut to it"], note: "Impatience with hedging." },
  { zh: ["说白了", "说实话", "老实说"], en: ["Honestly", "Let's be real", "Bottom line", "Truth is"], note: "Discourse marker; 'let's be real' is casual, 'bottom line' business." },
  { zh: ["不至于", "不至于吧"], en: ["It's not that bad", "Come on, really?", "That's a stretch"], note: "Downplaying; 'that's a stretch' when disputing a claim." },
  { zh: ["那谁", "那个谁"], en: ["you-know-who", "what's-his-name", "that guy", "her"], note: "Deliberate non-naming; 'you-know-who' keeps the suspense." },
  { zh: ["谁让", "谁叫"], en: ["Well, that's what you get for…", "Can't help it, we're…", "Blame it on…"], note: "'谁让我们是X呢' = 'what can you do, we're X' — a shrug, not a question." },
  { zh: ["我也没办法", "没办法", "我能怎么办"], en: ["What can I do?", "There's nothing I can do", "I don't have a choice", "It is what it is"], note: "Resignation; the rhetorical question reads most natural in speech." },
  { zh: ["怎么才来", "怎么这么晚", "怎么才到"], en: ["What kept you?", "You're late", "Where have you been?", "Took you long enough"], note: "Mild reproach for lateness; 'took you long enough' is teasing." },
  { zh: ["看你", "瞧你"], en: ["Look at you", "Would you look at that"], note: "Fond or mocking depending on tone." },

  // ---- endearment, teasing & family address --------------------------------
  { zh: ["丫头", "这丫头", "小丫头"], en: ["this girl", "this one", "kid", "sweetheart"], note: "Elder about a girl/young woman; fond. 'this one' when speaking about her to a third party." },
  { zh: ["小子", "这小子"], en: ["this kid", "this guy", "the boy", "punk"], note: "About a young man; 'punk' only when hostile." },
  { zh: ["奶奶"], en: ["Grandma", "your grandmother", "Nana"], note: "'Grandma' in speech; 'your grandmother' when a third party speaks formally." },
  { zh: ["爷爷", "外公", "姥爷"], en: ["Grandpa", "your grandfather", "Gramps"], note: "'Grandpa' in speech." },
  { zh: ["阿姨"], en: ["Auntie", "ma'am", "Mrs. + surname"], note: "To a non-relative older woman Americans use 'ma'am' or a name, not 'auntie'; keep 'Auntie' only for a real family friend." },
  { zh: ["叔叔"], en: ["Uncle", "sir", "Mr. + surname"], note: "Same as 阿姨: to strangers, 'sir' or a name." },
  { zh: ["哥", "大哥", "哥哥"], en: ["bro", "man", "Mr. + surname", "big brother"], note: "To a non-relative it is address, not kinship — use a name or 'man'; 'big brother' only for a real sibling." },
  { zh: ["姐", "姐姐", "小姐姐"], en: ["sis", "miss", "her name"], note: "Non-relative 姐 → the person's name; 'sis' only for a real sibling or very close friend." },
  { zh: ["老公"], en: ["honey", "babe", "my husband"], note: "As address: 'honey' / 'babe'; as reference: 'my husband'." },
  { zh: ["老婆"], en: ["honey", "babe", "my wife"], note: "As address: 'honey' / 'babe'; as reference: 'my wife'." },
  { zh: ["亲爱的"], en: ["honey", "sweetheart", "darling", "babe"], note: "'Darling' reads British or arch; 'honey' is the American default." },
  { zh: ["宝贝", "宝宝"], en: ["baby", "sweetie", "babe"], note: "To a partner 'babe'; to a child 'sweetie'." },
  { zh: ["乖", "乖乖"], en: ["Good girl", "Good boy", "There's a good…", "Be good"], note: "Soothing an inferior or child; can be creepy from a lover — keep the tone." },
  { zh: ["傻瓜", "笨蛋", "小傻子"], en: ["silly", "you idiot", "dummy", "goof"], note: "Fond insult; 'dummy' and 'silly' are affectionate, 'idiot' is harsher." },

  // ---- titles, rank & the office -------------------------------------------
  { zh: ["总", "沈总", "王总", "杨总", "李总", "张总", "陈总", "林总", "周总", "赵总"], en: ["Mr. + surname", "Ms. + surname", "boss", "sir"], note: "X总 = 'Mr./Ms. X' in speech; 'boss' only from subordinates in casual moments. Never 'CEO X' or 'President X' as address." },
  { zh: ["董事长"], en: ["the Chairman", "sir", "Mr. + surname"], note: "As reference 'the Chairman'; as address 'sir' or the name. Not 'chairman of the board' in dialogue." },
  { zh: ["部长"], en: ["Director + surname", "the director", "Ms./Mr. + surname"], note: "Corporate 部长 = 'Director', not 'Minister'." },
  { zh: ["经理"], en: ["Mr./Ms. + surname", "the manager", "boss"], note: "Drop the title in address; Americans use the name." },
  { zh: ["老板"], en: ["boss", "Mr./Ms. + surname", "the boss"], note: "'Boss' works as address from staff." },
  { zh: ["少爷"], en: ["young master", "sir", "Mr. + surname", "his name"], note: "Servant to heir: 'sir' or the name; 'young master' only if the period/wealth setting is being played up." },
  { zh: ["小姐"], en: ["miss", "Miss + surname", "ma'am", "her name"], note: "Servant to heiress 'miss'; strangers 'ma'am' or 'miss'." },
  { zh: ["太太", "夫人"], en: ["Mrs. + surname", "ma'am", "madam"], note: "'Ma'am' as address; 'madam' only from staff in a grand house." },
  { zh: ["老爷"], en: ["sir", "the master", "Mr. + surname"], note: "Household head, period feel; modern staff say 'sir'." },
  { zh: ["秘书", "助理"], en: ["assistant", "my assistant", "her name"], note: "Address by name; 'secretary' is dated in American offices." },
  { zh: ["各位", "大家"], en: ["everyone", "everybody", "all right, everyone"], note: "Opening a meeting: 'all right, everyone'." },
  { zh: ["汇报", "开会", "会议"], en: ["the briefing", "the meeting", "the update", "report in"], note: "汇报 in a boardroom = 'briefing' / 'update'; 'report' is fine as a verb." },
  { zh: ["合同", "签字", "签约"], en: ["the contract", "sign", "the deal", "the paperwork"], note: "'The deal' when the substance matters; 'the paperwork' when dismissive." },
  { zh: ["解约", "撤单", "毁约"], en: ["pull out", "kill the deal", "back out", "cancel the order"], note: "'Kill the deal' is how executives say 撤单." },
  { zh: ["收购", "并购"], en: ["buy out", "take over", "the acquisition", "the merger"], note: "'Buy out' / 'take over' in speech." },
  { zh: ["股份", "股权"], en: ["shares", "stake", "equity"], note: "'Stake' is the spoken word ('a 30% stake')." },
  { zh: ["项目"], en: ["the project", "the deal", "the account"], note: "In sales talk 项目 is often 'the deal' or 'the account'." },
  { zh: ["出差"], en: ["on a business trip", "away on business", "traveling for work"], note: "'Out of town' when the destination is irrelevant." },
  { zh: ["谈生意", "谈合作"], en: ["talk business", "do business", "talk about working together"], note: "Plain; never 'discuss cooperation'." },

  // ---- short-drama genre vocabulary ---------------------------------------
  { zh: ["豪门"], en: ["old money", "a powerful family", "the rich family", "high society"], note: "'Old money' when the family's standing is the point." },
  { zh: ["千金", "大小姐"], en: ["heiress", "daddy's girl", "the family's daughter", "princess"], note: "'Princess' is mocking; 'heiress' is neutral." },
  { zh: ["赘婿", "上门女婿"], en: ["the son-in-law who married in", "live-in son-in-law", "the husband who married up"], note: "No English word; state the status, then let the contempt show in the line." },
  { zh: ["私生子", "私生女"], en: ["illegitimate child", "love child", "bastard"], note: "'Bastard' is the insult; 'love child' is tabloid; 'illegitimate' is formal." },
  { zh: ["认亲", "身世"], en: ["find out who she really is", "the truth about her family", "her real parents"], note: "Plot beat, not a term: name the reveal." },
  { zh: ["报复", "复仇"], en: ["get back at", "payback", "make them pay", "revenge"], note: "'Make them pay' is the drama register." },
  { zh: ["替身", "替代品"], en: ["a stand-in", "a substitute", "a replacement", "second choice"], note: "Romance 替身 = 'stand-in' for the one they really want." },
  { zh: ["白月光"], en: ["the one who got away", "his first love", "the girl he never got over"], note: "No idiom; describe the role." },
  { zh: ["渣男"], en: ["scumbag", "a piece of work", "trash", "player"], note: "'Player' when it's about cheating; 'scumbag' general." },
  { zh: ["小三"], en: ["the other woman", "mistress", "homewrecker"], note: "'The other woman' is neutral; 'homewrecker' is the insult." },
  { zh: ["绿茶"], en: ["fake-sweet", "two-faced", "a snake", "manipulative"], note: "No tea metaphor in English; name the trait." },
  { zh: ["打脸"], en: ["put them in their place", "make them eat their words", "watch them squirm"], note: "Comeuppance beat." },
  { zh: ["逆袭"], en: ["turn the tables", "come out on top", "make a comeback"], note: "Underdog rise." },
  { zh: ["重生", "重活一次"], en: ["get a second chance at life", "start over", "live it all again"], note: "Genre trope; explain once, then use 'this time' / 'again'." },
  { zh: ["穿越"], en: ["end up in", "wake up in", "travel back to"], note: "Genre trope; use the concrete verb of arriving." },
  { zh: ["甩了", "被甩"], en: ["dump", "get dumped", "break up with"], note: "'Dump' is the American verb." },
  { zh: ["离婚协议", "离婚"], en: ["divorce papers", "the divorce", "sign the papers"], note: "'Sign the papers' is the beat." },
  { zh: ["假结婚", "契约婚姻", "协议结婚"], en: ["a fake marriage", "a marriage of convenience", "a paper marriage", "the arrangement"], note: "'The arrangement' once the premise is established." },
  { zh: ["门当户对"], en: ["from the same world", "a good match on paper", "suitable", "one of us"], note: "Class-match idiom; 'one of us' when a snob speaks." },

  // ---- chengyu that show up in dialogue ------------------------------------
  { zh: ["年轻有为"], en: ["young and sharp", "going places", "a rising star", "impressive for her age"], note: "Compliment; 'young and accomplished' is stiff." },
  { zh: ["深刻印象", "印象深刻"], en: ["made an impression", "stuck with me", "hard to forget"], note: "'Stuck with me' is the spoken form." },
  { zh: ["自作多情"], en: ["flatter yourself", "read too much into it", "get ahead of yourself"], note: "'Don't flatter yourself' is the standard retort." },
  { zh: ["一见如故"], en: ["hit it off", "click", "like we'd known each other forever"], note: "'Hit it off' is the idiom." },
  { zh: ["心知肚明"], en: ["we both know", "you know exactly what I mean", "no need to spell it out"], note: "Knowing without saying." },
  { zh: ["有眼无珠"], en: ["blind", "couldn't see what was in front of me", "a fool not to see it"], note: "Self-reproach or insult." },
  { zh: ["自不量力"], en: ["out of your league", "biting off more than you can chew", "don't know your place"], note: "'Out of your league' when the target is a person or a deal." },
  { zh: ["得寸进尺"], en: ["pushing it", "give an inch, take a mile", "don't push your luck"], note: "'Don't push your luck' as a warning." },
  { zh: ["不识好歹"], en: ["ungrateful", "don't know a good thing when you see it", "throwing it back in my face"], note: "Rejected favor." },
  { zh: ["无能为力"], en: ["there's nothing I can do", "my hands are tied", "it's out of my hands"], note: "'My hands are tied' when policy or a superior blocks." },
  { zh: ["不可理喻"], en: ["impossible", "unreasonable", "you can't talk to him", "insane"], note: "'You're impossible' to a person." },
  { zh: ["趁人之危"], en: ["take advantage", "kick someone when they're down", "prey on"], note: "Moral accusation." },
  { zh: ["恩将仇报"], en: ["bite the hand that feeds you", "this is how you repay me", "stab in the back"], note: "Betrayal after a favor." },
  { zh: ["背信弃义", "出尔反尔"], en: ["go back on your word", "break a promise", "double-cross"], note: "'Double-cross' when a deal is involved." },
  { zh: ["不择手段"], en: ["by any means necessary", "stop at nothing", "play dirty"], note: "Villain register: 'stop at nothing'." },
  { zh: ["天经地义", "理所当然"], en: ["obviously", "goes without saying", "that's just how it is", "of course"], note: "Spoken: 'obviously' / 'of course'." },
  { zh: ["情不自禁"], en: ["couldn't help it", "couldn't stop myself", "before I knew it"], note: "Romantic or angry impulse." },
  { zh: ["一厢情愿"], en: ["wishful thinking", "one-sided", "that's on you"], note: "Unrequited hope." },
  { zh: ["见钱眼开"], en: ["money-hungry", "eyes light up at money", "gold digger"], note: "'Gold digger' only about a partner." },
  { zh: ["半斤八两"], en: ["you're no better", "two of a kind", "same difference"], note: "Mutual accusation." },
  { zh: ["装傻", "装糊涂"], en: ["play dumb", "act like you don't know", "don't play innocent"], note: "'Don't play dumb' as a challenge." },
  { zh: ["死心", "死心吧"], en: ["give up", "let it go", "it's never going to happen", "move on"], note: "Ending a hope, often romantic." },
  { zh: ["认命"], en: ["accept it", "that's fate", "make peace with it", "it is what it is"], note: "Resignation." },
  { zh: ["缘分"], en: ["meant to be", "fate", "the universe", "it was our time"], note: "Avoid 'destiny' in casual speech; 'meant to be' is warm." },
  { zh: ["面子", "给面子", "丢脸", "没面子"], en: ["make me look bad", "show some respect", "humiliate", "save face"], note: "Concrete social stake: 'make me look bad' / 'humiliate me in front of everyone'." },
  { zh: ["委屈"], en: ["it's not fair", "hurt", "wronged", "swallow it"], note: "No single word: pick the beat — the feeling ('hurt'), the claim ('it's not fair'), or the suppression ('swallow it')." },
  { zh: ["撒娇"], en: ["pout", "play cute", "sweet-talk", "whine"], note: "'Pout' or 'play cute' for the act; 'sweet-talk' for the aim." },
  { zh: ["矫情"], en: ["dramatic", "precious", "so extra", "over the top"], note: "'So extra' is current casual." },
  { zh: ["靠谱", "不靠谱"], en: ["solid", "reliable", "sketchy", "flaky"], note: "'Sketchy' for a plan, 'flaky' for a person." },
  { zh: ["加油"], en: ["you've got this", "go get 'em", "hang in there", "good luck"], note: "'Hang in there' when things are hard; 'you've got this' before a challenge." },
  { zh: ["再说", "以后再说", "回头再说"], en: ["later", "we'll see", "let's talk later", "not now"], note: "Deferral; 'we'll see' is a soft no." },
  { zh: ["改天", "下次"], en: ["another time", "rain check", "next time", "some other time"], note: "'Rain check' when declining an invitation." },
];

type Compiled = { entry: IdiomEntry; form: string };
const compiled: Compiled[] = IDIOMS.flatMap((entry) => entry.zh.map((form) => ({ entry, form }))).sort(
  (a, b) => b.form.length - a.form.length
);

/**
 * Entries whose surface forms appear in the given lines, longest form first,
 * each entry once; single-character forms only match when the whole line is
 * that character (是 / 请 / 哥), so they never fire inside other words.
 */
export function matchIdioms(lines: string[], limit = 12): IdiomEntry[] {
  const seen = new Set<IdiomEntry>();
  const out: IdiomEntry[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/[\s，。！？；：…—、“”‘’"'!?.,]/g, "");
    for (const { entry, form } of compiled) {
      if (seen.has(entry)) continue;
      const hit = form.length === 1 ? trimmed === form : trimmed.includes(form);
      if (!hit) continue;
      seen.add(entry);
      out.push(entry);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function idiomBlock(entries: IdiomEntry[]): string | null {
  if (!entries.length) return null;
  const rows = entries.map((e) => `- ${e.zh[0]} → ${e.en.join(" / ")}\n    ${e.note}`);
  return `SET PHRASES IN THIS SCENE (Pulsar register guide)
These Chinese phrases appear in the lines below and have no one-to-one English. The options are how American series say them, most common first; the note says when each fits. Choose by speaker and beat; you may write something better if it is in the same register.

${rows.join("\n")}`;
}
