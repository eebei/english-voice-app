# OMORAY PITWALL — Homepage Change Proposal, Next Phase

> **Decision status / 方針状態（2026-08-10）：訂正中**  
> The free five-day trial is retired. The entry offer is a paid US$9.99 Starter Pass. Its access period and the post-Starter price are not specified in this document and must not be invented. Public payment wording remains unchanged until the operation is implemented and verified.  
> 5日間無料トライアルは廃止。新規入口は有料US$9.99のStarter Passとする。利用期間とStarter後の価格は、この文書では未確定であり、勝手に設定しない。運用フローを実装・検証するまで、公開の決済文言は変更しない。

## English proposal

### Direction (corrected)

Reposition the homepage around one clear promise: **PITWALL helps a sim racer prepare a race plan, make calmer decisions during the race, and learn from the result afterward.** The free five-day trial is not part of the future offer; the entry offer is a paid US$9.99 Starter Pass.

Do not sell unverified autonomy. GT3 road-race fuel, pit, rejoin, and strategy behaviour should be presented as an active real-driver validation program until the relevant Build has measured evidence.

### What the current public page says

The current page (`public/pitwall.html`) states a US$29.99 monthly Founding subscription, a five-day free trial, and a referral reward of 33% off per paid referral / a free next month at three. `public/refer.html`, `public/help.html`, and `public/terms.html` repeat the same subscription and Stripe-based model.

Therefore, do not change public copy to "prepaid" until the checkout, entitlement, referral-credit ledger, support instructions, and terms all support it.

### Proposed homepage structure

1. **Hero: outcome before technology**

   English headline:

   > Your race engineer for the moments that decide the race.

   English supporting copy:

   > Build a plan before green. Get concise radio when the situation changes. Review the race while the details are still fresh.

   Japanese headline:

   > 勝負どころで判断を返す、あなたのレースエンジニア。

   Japanese supporting copy:

   > スタート前にプランを組む。状況が変われば簡潔な無線を受ける。レース直後に、記憶が新しいうちに振り返る。

   Primary CTA must describe the paid US$9.99 Starter Pass only after its duration and checkout operation are defined. Do not retain a free-trial CTA.

   Secondary CTA: `See what is being tested` / `現在のテスト内容を見る`

2. **Three real race moments**

   - **Before green — Plan the race**
     - Race format, grid position, known fuel history, Plan A / B / C discussion.
   - **During the race — Make the next decision**
     - Fuel, planned pit window, traffic/rejoin context, concise radio.
   - **After checker — Carry the learning forward**
     - Debrief, driver notes, and the next-session context.

   Describe these as product goals or available functions only when supported by measured Builds. Do not imply that every call is autonomous or guaranteed.

3. **Now Testing: move it near the first CTA**

   Replace broad feature claims with a compact status panel:

   | Area | Public status | Evidence standard |
   | --- | --- | --- |
   | GT3 road-course fuel and planned pit calls | Invited-driver validation | Real-run trace plus tester feedback |
   | Rejoin forecast | Invited-driver validation | Predicted and actual position recorded |
   | Race radio profiles and lap readout | Active development | Deterministic handler trace and real-run check |
   | Endurance strategy | Research and validation | Event-specific fuel/pit data and driver review |
   | Oval, dirt, and unvalidated classes | Not yet tuned | No implied support |

   Japanese labels may be used in the Japanese page, but the status must stay factual: `招待ドライバー検証中`, `開発中`, `未調整`.

   **Scope decision:** remove the public development-driver recruitment cards for Super Formula, GTP/prototypes, and INDYCAR. Do not replace them with waitlists, free-month offers, or a "coming soon" sales claim. The public testing story is GT3 road racing and endurance only.

4. **Proof instead of a long manifesto**

   Keep the founder story lower on the page. Add a short evidence section above pricing with only measured examples, for example:

   - `Real-driver GT3 validation`
   - `Pit exit forecast: predicted P4, actual P3 in a recorded run`
   - `What happens next: every tester report becomes a traceable product decision`

   Do not add a testimonial or a performance claim unless it can be linked to a real person’s permission and a specific recorded session.

5. **Pricing and referral: use one mechanism, not a marketing promise**

   Recommended future model: a **30-day Race Pass with Referral Credit**, not an automatic recurring-discount promise.

   - Entry offer: a paid US$9.99 Starter Pass. Its duration is deliberately **TBD**; do not label it a 30-day pass without a product decision.
   - A new customer receives a personal referral link after their first paid pass begins.
   - A referral qualifies only after the referred driver completes the Starter Pass and successfully begins their first standard paid pass.
   - Each qualified referral earns US$10.00 Referral Credit.
   - Credits are applied automatically to the referrer’s next Race Pass purchase.
   - Three qualified referrals create US$30.00 credit. The eligible standard pass and its price must be defined before promising a free pass.
   - Credit is non-cash, non-transferable, and cannot discount a purchase below US$0.
   - Recommended expiry: 12 months from qualification. This limits open-ended liability while giving drivers a fair time window.
   - A referral’s first paid purchase cannot be paid with referral credit; this prevents circular no-revenue chains.
   - Referral credit should be visible as a simple balance: `US$20 credit · one more paid referral unlocks a free Race Pass`.

   This works for prepaid service because there is no dependency on a future automatic card charge. The reward is a balance against the next voluntary pass purchase. It can preserve the user-facing simplicity of “three paid drivers = one free pass” once the standard pass is defined.

6. **Do not change pricing copy until the operation exists**

   Before the public page describes the Starter Pass or a standard pass, build and verify:

   - checkout for a non-recurring pass;
   - a reliable access-expiry entitlement;
   - referral attribution and paid-conversion event;
   - immutable credit ledger and manual support view;
   - credit application at checkout;
   - terms, help, welcome email, and share-page wording;
   - cancellation/refund wording appropriate to prepaid access.

   Until then, retain the current subscription wording, but reduce the promotional emphasis on “ride free again and again” because the accounting model has not been verified for the new direction.

7. **Share flow: make it a driver result, not a generic ad**

   Replace the generic social templates with one focused flow:

   - A personal referral URL plus a visible code.
   - One short selectable post format: `race plan`, `radio moment`, or `debrief lesson`.
   - One branded square/vertical asset suitable for Discord, X, Instagram, and YouTube descriptions.
   - A plain disclosure: referral credit is earned only after a referred driver becomes paid.
   - Do not ask users to share private access codes.

### Recommended implementation order

1. Rewrite the hero, race-moment section, and Now Testing panel using only evidence-backed language.
2. Simplify current pricing/referral copy so it accurately describes the currently operating payment model.
3. Design and implement the prepaid Race Pass + Referral Credit operation outside the homepage.
4. Once the operation is verified, update the page, terms, help, welcome email, and share page together.
5. Add tracked referral links and a share asset after the referral ledger is reliable.

### Remaining commercial decision

The adopted direction is a paid US$9.99 Starter Pass with no free five-day trial. Before any public pricing implementation, define only these two missing values:

1. Starter Pass access period.
2. Standard prepaid pass price and access period after the Starter Pass.

No public payment, referral, or pricing claim changes until the required operational flow is implemented and verified.

---

## 日本語提案

### 結論（訂正）

ホームページの約束は一つに絞る。5日間無料トライアルは今後の提供内容に含めず、新規の入口は有料US$9.99のStarter Passとする。

**PITWALLは、レース前にプランを組み、走行中の変化で落ち着いた判断を返し、終わったレースから次へ学びをつなぐ。**

GT3ロードの燃料・ピット・復帰順位・戦略は、関連Buildの実測証拠が揃うまで「招待ドライバーによる実走検証中」として扱う。検証されていない自律判断を売り文句にしない。

### 現在の公開ページが記載していること

現在の`public/pitwall.html`は、月額US$29.99のFoundingサブスクリプション、5日間無料トライアル、紹介で一人につき33%オフ／三人で次月無料を掲載している。`public/refer.html`、`public/help.html`、`public/terms.html`も同じサブスク／Stripe前提を繰り返している。

したがって、checkout、アクセス権、紹介クレジット台帳、サポート案内、利用規約まで揃う前に、公開文言だけを「プリペイド」に変更してはいけない。

### 提案するホームページ構成

1. **Hero：技術より先に結果を伝える**

   英文見出し：

   > Your race engineer for the moments that decide the race.

   英文補足：

   > Build a plan before green. Get concise radio when the situation changes. Review the race while the details are still fresh.

   日本語見出し：

   > 勝負どころで判断を返す、あなたのレースエンジニア。

   日本語補足：

   > スタート前にプランを組む。状況が変われば簡潔な無線を受ける。レース直後に、記憶が新しいうちに振り返る。

   主CTAは、Starter Passの利用期間とcheckout運用が決まってから、有料US$9.99 Starter Passとして記載する。無料トライアルCTAは残さない。

   副CTA：`See what is being tested`／`現在のテスト内容を見る`

2. **レースの三つの瞬間**

   - **グリーン前 — レースを組み立てる**
     - レースフォーマット、予選順位、既知の燃費履歴、Plan A／B／Cの相談。
   - **レース中 — 次の判断をする**
     - 燃料、予定ピット窓、トラフィック／復帰文脈、簡潔な無線。
   - **チェッカー後 — 次に生かす**
     - デブリーフ、ドライバーの申告、次セッションへの文脈。

   これらは、実測済みの機能だけを「できること」と書く。全コールが自律的・保証付きであるかのようには書かない。

3. **Now Testingを最初のCTA近くへ**

   広い機能主張の代わりに、簡潔なステータス表を置く。

   | 領域 | 公開ステータス | 証拠基準 |
   | --- | --- | --- |
   | GT3ロードの燃料と予定ピットコール | 招待ドライバー検証中 | 実走traceとテスターフィードバック |
   | 復帰順位予測 | 招待ドライバー検証中 | 予測順位と実順位の記録 |
   | Race Radio ProfileとLap Readout | 開発中 | 決定論的handler traceと実走確認 |
   | 耐久戦略 | 調査・検証中 | イベント固有の燃料／ピットデータとドライバー評価 |
   | オーバル、ダート、未検証クラス | 未調整 | 対応を匂わせない |

   日本語ページでは、`招待ドライバー検証中`、`開発中`、`未調整`を事実に合わせて使う。

   **対象範囲の決定：** Super Formula、GTP／プロトタイプ、INDYCARの開発ドライバー募集カードは公開ページから外す。waitlist、初月無料、`coming soon`の販売表現にも置き換えない。公開する検証ストーリーはGT3ロードと耐久だけに絞る。

4. **長いマニフェストより証拠**

   創業者ストーリーはページ下部へ残す。料金の前に短い実証セクションを置く。

   - `Real-driver GT3 validation`
   - `Pit exit forecast: predicted P4, actual P3 in a recorded run`
   - `What happens next: every tester report becomes a traceable product decision`

   本人許可と具体的な走行記録がないテスティモニアル／性能主張は追加しない。

5. **料金と紹介：広告文ではなく、一つの運用ルールにする**

   将来の推奨モデルは、継続課金の割引ではなく、**30日Race Pass＋紹介クレジット**。

   - 新規入口：有料US$9.99のStarter Pass。利用期間は**未確定**であり、30日と書かない。
   - 最初の有料Pass開始後、本人用の紹介リンクを発行。
   - 紹介は、相手がStarter Passを完了し、最初の通常有料Passを開始した時だけ成立。
   - 成立紹介一人につき、US$10.00の紹介クレジット。
   - クレジットは、紹介者の次のRace Pass購入に自動適用。
   - 三人成立でUS$30.00。どの通常Passに充当して無料にするかは、通常Passの価格・期間を決めてから約束する。
   - クレジットは現金化不可・譲渡不可・購入額をUS$0未満にしない。
   - 推奨期限：成立から12か月。ドライバーには十分な期間を残し、無期限の負債にはしない。
   - 紹介された側の最初の有料購入には紹介クレジットを使えない。売上が発生しない循環を防ぐ。
   - 表示はシンプルにする。例：`US$20 credit · one more paid referral unlocks a free Race Pass`。

   これはプリペイドに合う。将来の自動カード請求を前提にせず、次に本人が購入するPassへ残高を当てる方式だから。通常Passを決めれば、「有料ドライバー三人で次のPass無料」という分かりやすさも保てる。

6. **運用ができるまで料金文言は変えない**

   Starter Passまたは通常Passを公開する前に、次を実装・確認する。

   - 非継続型Passのcheckout
   - 信頼できるアクセス期限
   - 紹介の紐付けと有料転換イベント
   - 変更不能なクレジット台帳と手動サポート画面
   - checkoutでのクレジット適用
   - 利用規約、Help、Welcomeメール、Shareページの統一
   - プリペイドに合う解約／返金案内

   それまではサブスク前提の現行文言を残す。ただし新しい方向に対して未検証なため、「何度でも無料で走れる」の販促は弱める。

7. **SNS共有：汎用広告でなく、ドライバーの結果を共有する**

   現在の汎用テンプレートを、次の一つの流れへ絞る。

   - 本人の紹介URLと見える紹介コード。
   - 選べる短文投稿：`race plan`、`radio moment`、`debrief lesson`。
   - Discord、X、Instagram、YouTube概要欄に使える正方形／縦型のブランド素材一枚。
   - 紹介クレジットは、紹介相手が有料化して初めて成立する、と明記。
   - 個人用アプリアクセスコードの共有は促さない。

### 推奨実装順

1. 実測だけを根拠に、Hero、レースの三つの瞬間、Now Testingを更新。
2. 現在実際に動いている決済モデルに合わせ、料金／紹介文言を簡潔化。
3. ホームページ外で、プリペイドRace Pass＋紹介クレジットの運用を設計・実装。
4. 運用検証後、ホーム、規約、Help、Welcomeメール、Shareページを同時更新。
5. 紹介台帳が信頼できる段階で、計測付き紹介URLとSNS素材を追加。

### 残る商用決定

採用した方針は「無料5日間なし・有料US$9.99 Starter Pass」。公開実装前に、次の二点だけ決める。

1. Starter Passの利用期間。
2. Starter Pass後の通常プリペイドPassの価格と利用期間。

必要な運用フローを実装・検証するまで、料金・紹介・決済について公開主張は変更しない。
