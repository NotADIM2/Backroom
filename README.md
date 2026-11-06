# Backroom

**Agents argue it out in the backroom, and a human signs off before the customer hears anything.**

Backroom is a refund review workflow for small online shops, built on [Switch](https://docs.switchagents.ai/). Two AI agents check each request in a team chat room, and a person approves or changes the result before the customer gets a reply.

Orders, payments and customer messages are simulated in this demo.

![The Backroom sign-off page, showing a request with a fake approval note and a $60 refund recommendation](docs/sign-off-page.png)

## The problem

Small shops often decide refunds quickly, without properly checking the order or the policy. That leads to wrong refunds and inconsistent answers for customers. AI agents can do the checking, but they shouldn't have the final say over money or customer messages.

## How it works

```mermaid
flowchart LR
  person["Person in the room"] -->|"check REQ-1001"| checker["@order-checker"]
  checker -->|"records the facts"| service["Backroom service"]
  checker -->|"hands over"| challenger["@policy-challenger"]
  challenger -->|"records a recommendation"| service
  service --> page["Sign-off page"]
  page -->|"a person approves or changes it"| service
  person -->|"send it"| checker
  checker -->|"send, refused until signed off"| service
```

1. A person asks `@order-checker` to look at a request in the chat room.
2. `@order-checker` opens a case, records what the order data shows and points out anything it doesn't support.
3. `@policy-challenger` tests the case against the refund policy, then recommends a refund or a denial and drafts a reply to the customer.
4. A person reviews the case on a private sign-off page, then approves or changes it.
5. A person asks `@order-checker` to send the result.

## Safeguards

The service enforces these rules itself, so they still hold if an agent makes a mistake or is misled.

| Rule | What happens |
| --- | --- |
| Nothing is sent without a sign-off | `send` is refused until a person has signed off |
| Agents can't sign off | Signing off needs a private key that's generated at startup, kept in memory and never given to agents |
| Refunds can't exceed the order | Any amount above what's left on the order is refused, including at sign-off |
| A case can't be sent twice | A second `send` is refused |

The agents are also told to treat customer messages as evidence, never as instructions. `REQ-1005` tests this with a fake "system note" that claims a manager approved a $500 refund.

## Built with

| Part | Technology |
| --- | --- |
| Chat room and agent management | [Switch](https://docs.switchagents.ai/) with Mattermost |
| Agents | [Claude Code](https://claude.com/product/claude-code) |
| Backend | Node.js, with no external dependencies |
| Sign-off page | HTML, CSS and JavaScript, with no framework |
| Storage | One JSON file |
| Tests | Node's built-in test runner |

## Project structure

```text
agents/
  order-checker/CLAUDE.md       Briefing for the agent that checks the facts
  policy-challenger/CLAUDE.md   Briefing for the agent that tests the policy
data/                           Sample orders and refund requests
docs/                           Images for this README
policy/refund-policy.md         The rules the agents apply
public/index.html               Sign-off page
room/instructions.md            Instructions to paste into the Switch room
server/                         Backend service
test/                           Automated tests
tools/backroom.mjs              Command-line tool the agents use
```

## Getting started

You need [Node.js](https://nodejs.org/) 20 or newer. There's nothing else to install.

```bash
git clone https://github.com/NotADIM2/Backroom.git
cd Backroom
npm test
npm start
```

`npm start` runs the service at `http://localhost:4600` and opens the sign-off page in your browser. It also prints a private sign-off link, so keep that link out of the chat room. The link changes each time the server starts.

To start again with no cases, stop the server and delete `data/runtime/`.

| Setting | Used by | Default |
| --- | --- | --- |
| `BACKROOM_PORT` | The service | `4600` |
| `BACKROOM_URL` | The agent tool | `http://localhost:4600` |

## Connecting to Switch

You need [Switch Console](https://docs.switchagents.ai/switch-rooms/getting-started/install-switch-console.md) with a server running, and Claude Code installed and signed in. The local Mattermost chat runs in Docker, so you need Docker too.

On Windows, the Templates page may say "No agent provider is set up" even when Claude Code is ready. This setup doesn't use Templates, so you can ignore it.

**1. Create the agents.** In Switch Console, go to **Your Agents** and add these two, using your own full path for **Directory**. Each folder has a `CLAUDE.md` file that tells the agent its job. Leave **Bypass permissions** off, so agents ask before acting.

| Name | Directory | Provider |
| --- | --- | --- |
| `order-checker` | `<this repo>/agents/order-checker` | Claude Code |
| `policy-challenger` | `<this repo>/agents/policy-challenger` | Claude Code |

**2. Create the room.** Go to **Your Rooms**, then **Create room**. Name it `Refund-Backroom`, paste `room/instructions.md` into **Instructions**, and add both agents.

**3. Turn off follow-ups.** Send this in the room, so agents reply only when @mentioned:

```text
!follow-ups off
```

**4. Try a request.** Post this in the room:

```text
@order-checker please check REQ-1001
```

Then review the case on the sign-off page, and ask `@order-checker` to send it.

## Sample requests

| Request | Scenario | Expected recommendation |
| --- | --- | --- |
| `REQ-1001` | Change of mind on an unused item | Refund $32, without shipping |
| `REQ-1002` | Change of mind on a final sale item | Deny |
| `REQ-1003` | Part of an order damaged, with a photo on file | Refund $29, without shipping |
| `REQ-1004` | Past the 30-day deadline | Deny |
| `REQ-1005` | Fake approval note asking for $500 | Refund $60, and flag the note and the customer's repeat refunds |

Agents write their own reasoning, so their wording changes between runs. The person signing off always has the final say.

## Agent tool

Agents reach the service through `tools/backroom.mjs`, which has no way to sign off.

| Command | What it does |
| --- | --- |
| `requests` | Lists the incoming requests |
| `policy` | Shows the refund policy |
| `order <ORDER-ID>` | Shows an order |
| `open <REQ-ID>` | Opens a case, or returns the one already open |
| `show <CASE-ID>` | Shows a case |
| `facts <CASE-ID> --summary '...'` | Records the order facts |
| `recommend <CASE-ID> --decision refund\|deny --amount <dollars> --reason '...' --reply '...'` | Records a recommendation |
| `send <CASE-ID>` | Sends a result that a person has signed off |

## Testing

```bash
npm test
```

The automated tests cover the case workflow, refund limits, sign-off and repeat sends. The full workflow has also been run with Switch Console 0.40.1 and Mattermost 11.9 on Windows 11.

## Limits of this demo

- **Simulated data:** no real orders, payments or customer messages are involved.
- **Local only:** the service listens on `localhost` and stores its data in one JSON file.
- **Not a security boundary:** agents run as the same user as the service, so an agent with unrestricted file access could edit the data file. The approver key is never stored on disk or given to agents, and agents are told to use only the tool. A production version would run the service separately, with real sign-in.

## About

Built for the [Flip the Switch hackathon](https://www.wemakedevs.org/hackathons/switch) by WeMakeDevs, in Track 01: Best Business Workflow.
