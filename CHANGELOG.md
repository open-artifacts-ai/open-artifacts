# Changelog

## [0.74.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.74.0...v0.74.1) (2026-10-28)


### Bug Fixes

* **members:** uncertain invite title when emailed; T19 [#764](https://github.com/open-artifacts-ai/open-artifacts/issues/764) finds its person ([#834](https://github.com/open-artifacts-ai/open-artifacts/issues/834)) ([c44c1c0](https://github.com/open-artifacts-ai/open-artifacts/commit/c44c1c0608cff498c1036e01cd6fbe3b8fe93035))

## [0.74.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.73.0...v0.74.0) (2026-10-28)


### Features

* **dashboard:** P6 sign-in warnings: hosting line, invite and share reach, Access refusal ([#800](https://github.com/open-artifacts-ai/open-artifacts/issues/800)) ([aa3ebb6](https://github.com/open-artifacts-ai/open-artifacts/commit/aa3ebb610e441dc055eabc8920a6aa004ba95ebf))
* **spaces:** an Every space role is a floor: 409 managed_by_org_mapping (item 19) ([#820](https://github.com/open-artifacts-ai/open-artifacts/issues/820)) ([3ec6f12](https://github.com/open-artifacts-ai/open-artifacts/commit/3ec6f127c581ea93a02efe4f5f64c37539f8b48c))
* **viewer:** live sockets wait out the server's retry hint after an access change ([#816](https://github.com/open-artifacts-ai/open-artifacts/issues/816)) ([#821](https://github.com/open-artifacts-ai/open-artifacts/issues/821)) ([4d2abb0](https://github.com/open-artifacts-ai/open-artifacts/commit/4d2abb0a6a518a42be3a8b824ce722e9f9898b08))


### Bug Fixes

* **audit:** artifact delete, undelete and purge write audit rows ([#825](https://github.com/open-artifacts-ai/open-artifacts/issues/825)) ([fe3bcf7](https://github.com/open-artifacts-ai/open-artifacts/commit/fe3bcf72691ffb106411213dda4ff1da4141e8cf))
* **ci:** the prod migration guard compares with the version prod runs ([#822](https://github.com/open-artifacts-ai/open-artifacts/issues/822)) ([3cbb7ee](https://github.com/open-artifacts-ai/open-artifacts/commit/3cbb7eea06e7f38ad62cf023de1e996af0b16e62))
* **runtime:** review items 22, 23, 29, 38 (server and runtime package) ([#816](https://github.com/open-artifacts-ai/open-artifacts/issues/816)) ([4dcb23d](https://github.com/open-artifacts-ai/open-artifacts/commit/4dcb23d0fd244eeb990c1e270ed712a140f792e9))

## [0.73.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.72.0...v0.73.0) (2026-10-28)


### Features

* **dashboard:** Trash view: restore deleted artifacts within 30 days (item 9) ([#766](https://github.com/open-artifacts-ai/open-artifacts/issues/766)) ([be229c8](https://github.com/open-artifacts-ai/open-artifacts/commit/be229c82a98586a151b4cacd97009e13543326e0))
* **render:** the image view: one &lt;img&gt; of the entry, fit to the frame ([#783](https://github.com/open-artifacts-ai/open-artifacts/issues/783)) ([7e7bf36](https://github.com/open-artifacts-ai/open-artifacts/commit/7e7bf36f337a7193d07282eaed04208b8b813bd6))
* **spaces:** Every space group rows can't be removed or lowered below the group (item 19) ([#810](https://github.com/open-artifacts-ai/open-artifacts/issues/810)) ([8bf3cb2](https://github.com/open-artifacts-ai/open-artifacts/commit/8bf3cb285cdee10750266216c01c022e753bdea6))
* **spaces:** New space has "Add me as a manager", on by default ([#807](https://github.com/open-artifacts-ai/open-artifacts/issues/807)) ([b36b96d](https://github.com/open-artifacts-ai/open-artifacts/commit/b36b96d40e8a1c485230a2580d55b54b7f5f99d6))
* **viewer:** View only follows can.dataWrite on every install (review item 28) ([#794](https://github.com/open-artifacts-ai/open-artifacts/issues/794)) ([6ff1991](https://github.com/open-artifacts-ai/open-artifacts/commit/6ff199179376959f79f58f470904743f54c57547))


### Bug Fixes

* **auth-broker:** a late Google return goes back to the install as expired ([#809](https://github.com/open-artifacts-ai/open-artifacts/issues/809)) ([36e00c2](https://github.com/open-artifacts-ai/open-artifacts/commit/36e00c267a7e1ad1915f3554bd9ac933fc30519c))
* **auth:** later review items 13, 33, 36b, 40 ([#813](https://github.com/open-artifacts-ai/open-artifacts/issues/813)) ([2a6cdf2](https://github.com/open-artifacts-ai/open-artifacts/commit/2a6cdf2947508559277991641874479c375a7209))
* **spaces:** the creator manages a new space (addMe, default true) ([#806](https://github.com/open-artifacts-ai/open-artifacts/issues/806)) ([685c7e7](https://github.com/open-artifacts-ai/open-artifacts/commit/685c7e79e5fe0d9dee8e921bf4494f7b1e8c6751))
* **viewer:** the shell bridge follows the artifact's live access settings (item 38) ([#814](https://github.com/open-artifacts-ai/open-artifacts/issues/814)) ([695bd93](https://github.com/open-artifacts-ai/open-artifacts/commit/695bd9399bdc140eae2f773541aa35d9f04aab85))

## [0.72.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.71.0...v0.72.0) (2026-10-28)


### Features

* image artifact format (PNG, JPEG, GIF, WebP, SVG) with guarded migration 0017 ([#782](https://github.com/open-artifacts-ai/open-artifacts/issues/782)) ([eb5a450](https://github.com/open-artifacts-ai/open-artifacts/commit/eb5a450ea5419ffb7fefc5965f883bee676ad4df))
* **members:** Remove says they lose access to what was shared with them too (item 7) ([#796](https://github.com/open-artifacts-ai/open-artifacts/issues/796)) ([c709c18](https://github.com/open-artifacts-ai/open-artifacts/commit/c709c18b9cd502d2fc252302fff6f2754718f4a6))


### Bug Fixes

* **server:** P6 hosted gating, invite and share reach, AuthProviders.hosted, Access refusals (review 39, 11, 37, 36c, 12) ([#799](https://github.com/open-artifacts-ai/open-artifacts/issues/799)) ([45b8cbc](https://github.com/open-artifacts-ai/open-artifacts/commit/45b8cbc2ab594944ea4ab91c40a169491ab833f0))
* **spaces:** a shared space named Personal reads "Personal (shared)" ([#804](https://github.com/open-artifacts-ai/open-artifacts/issues/804)) ([656032c](https://github.com/open-artifacts-ai/open-artifacts/commit/656032c9ce7e5bbde71bf978205eca0ec32b6653))

## [0.71.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.70.0...v0.71.0) (2026-10-28)


### Features

* **upload:** say up front when the viewer can't open a file; map [#775](https://github.com/open-artifacts-ai/open-artifacts/issues/775)'s refusals ([#780](https://github.com/open-artifacts-ai/open-artifacts/issues/780)) ([46111de](https://github.com/open-artifacts-ai/open-artifacts/commit/46111de41c19b1a64823af6575934f16c5d9ec1c))


### Bug Fixes

* **members:** a removed member or guest stays removed (their shares are dropped) ([#795](https://github.com/open-artifacts-ai/open-artifacts/issues/795)) ([f8278d7](https://github.com/open-artifacts-ai/open-artifacts/commit/f8278d7798c89a82d9c23e5483fa524bf286933a))

## [0.70.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.69.1...v0.70.0) (2026-10-28)


### Features

* **ops:** redline-deploy puts a release candidate on the red-line installs ([#789](https://github.com/open-artifacts-ai/open-artifacts/issues/789)) ([c2965ad](https://github.com/open-artifacts-ai/open-artifacts/commit/c2965adbf1428eb87896754a92c64596ef0a58f7))
* **settings:** the owner sees why a sign-in method is off, on Instance ([#786](https://github.com/open-artifacts-ai/open-artifacts/issues/786)) ([de10dc9](https://github.com/open-artifacts-ai/open-artifacts/commit/de10dc938ec636732650949995a7e77879d82796))
* **spaces:** "Personal" is a reserved space name, shown inline; spaces e2e expects /me spaces ([#770](https://github.com/open-artifacts-ai/open-artifacts/issues/770)) ([9477aa1](https://github.com/open-artifacts-ai/open-artifacts/commit/9477aa17fcd931ce1a850bb6ba9670c74333d867))


### Bug Fixes

* refuse files no viewer can show (publish format guard) ([#775](https://github.com/open-artifacts-ai/open-artifacts/issues/775)) ([5beb0e8](https://github.com/open-artifacts-ai/open-artifacts/commit/5beb0e8a49b097e0d703d8b5ede91db1551dac01))
* **server:** sign-in config problems are logged and shown to owners; no codes without email ([#785](https://github.com/open-artifacts-ai/open-artifacts/issues/785)) ([c04c770](https://github.com/open-artifacts-ai/open-artifacts/commit/c04c7709b19d30594ef63df841987dafc9244166))

## [0.69.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.69.0...v0.69.1) (2026-10-28)


### Bug Fixes

* **directory:** P2.5 directory sync ([#767](https://github.com/open-artifacts-ai/open-artifacts/issues/767)) ([abeb28d](https://github.com/open-artifacts-ai/open-artifacts/commit/abeb28d9b7a5118fb8df35c593999f41b9c96375))

## [0.69.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.68.2...v0.69.0) (2026-10-28)


### Features

* **hosted:** the TIER var: provisioning derives FEATURES from it; Me reports it ([#772](https://github.com/open-artifacts-ai/open-artifacts/issues/772)) ([74b5fc6](https://github.com/open-artifacts-ai/open-artifacts/commit/74b5fc69a6370bd8b363906d2fec982551a842b6))
* **spaces:** Add people searches R.spaceCandidates; People reads restriction from its rows ([#764](https://github.com/open-artifacts-ai/open-artifacts/issues/764)) ([6f0a0a4](https://github.com/open-artifacts-ai/open-artifacts/commit/6f0a0a47781c44cbed84bd828ebdea436931090a))


### Bug Fixes

* **render:** binary or oversized code entries show a note with Download, never a hang ([#773](https://github.com/open-artifacts-ai/open-artifacts/issues/773)) ([151d78f](https://github.com/open-artifacts-ai/open-artifacts/commit/151d78feb0c672faca283dad327325a12b798e07))
* **server:** GET /me returns spaces; refuse "Personal" as a space name ([#768](https://github.com/open-artifacts-ai/open-artifacts/issues/768)) ([833e77d](https://github.com/open-artifacts-ai/open-artifacts/commit/833e77d594d93b40316e3899c0076c4dcbc8252b))

## [0.68.2](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.68.1...v0.68.2) (2026-10-27)


### Bug Fixes

* **auth:** log every code_send outcome; test OTP copy and outcome in D1 ([#754](https://github.com/open-artifacts-ai/open-artifacts/issues/754)) ([785e943](https://github.com/open-artifacts-ai/open-artifacts/commit/785e9433c7501d46821c7e31361d4c5d3138be7f))

## [0.68.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.68.0...v0.68.1) (2026-10-27)


### Bug Fixes

* **dashboard:** Access on direct sign-in, no Mine in shared spaces, live reconnects, truthful copy ([#749](https://github.com/open-artifacts-ai/open-artifacts/issues/749)) ([f78e362](https://github.com/open-artifacts-ai/open-artifacts/commit/f78e36279585536f9dd60de39c145786f8c551c1))

## [0.68.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.67.0...v0.68.0) (2026-10-27)


### Features

* **server:** POST /api/v1/admin/broker-check proves the install reaches its brokers ([#730](https://github.com/open-artifacts-ai/open-artifacts/issues/730)) ([87f1ec0](https://github.com/open-artifacts-ai/open-artifacts/commit/87f1ec07b77eddafe35d6c9c7c7637a600e2ca57))


### Bug Fixes

* **auth-broker:** separate per-install buckets for authorize and redeem ([#744](https://github.com/open-artifacts-ai/open-artifacts/issues/744)) ([37ef090](https://github.com/open-artifacts-ai/open-artifacts/commit/37ef0904b270ecaecd35ff4eb88e03d0f438943f))
* **dashboard:** a query error never renders as no results ([#747](https://github.com/open-artifacts-ai/open-artifacts/issues/747)) ([4954fa4](https://github.com/open-artifacts-ai/open-artifacts/commit/4954fa460e6347b9d76a0da3b6d58057df7ea0ad))
* **dashboard:** Departed lists only suspended or removed members ([#736](https://github.com/open-artifacts-ai/open-artifacts/issues/736)) ([802a890](https://github.com/open-artifacts-ai/open-artifacts/commit/802a8906174162fc9ac8125cb6903cb49f9a01be))
* **dashboard:** space managers can Restore a deleted artifact; truthful space-delete copy ([#743](https://github.com/open-artifacts-ai/open-artifacts/issues/743)) ([9dffd3b](https://github.com/open-artifacts-ai/open-artifacts/commit/9dffd3b97ce9ed1b80e3d62c4f9d413e7d97a907))
* **hosted:** health checks require /healthz to report this install's id ([#746](https://github.com/open-artifacts-ai/open-artifacts/issues/746)) ([027e35b](https://github.com/open-artifacts-ai/open-artifacts/commit/027e35bd7dbbf6a5029cf74dc615ce7811f9931f))
* **provision:** render DIRECTORY_BROKER_URL so hosted directory sync isn't dead ([#742](https://github.com/open-artifacts-ai/open-artifacts/issues/742)) ([1e6d945](https://github.com/open-artifacts-ai/open-artifacts/commit/1e6d945180145d0d2fd34dd9f161d29b1f1b00b7))
* **redline:** fixed spaces are per test domain; setup hook refusals give a reason after the key ([#738](https://github.com/open-artifacts-ai/open-artifacts/issues/738)) ([7f48733](https://github.com/open-artifacts-ai/open-artifacts/commit/7f487339b94cd7e197ea2d17066dd9f3b1614adf))
* **server:** GET /members honours ?status=, so Departed lists only suspended and removed members ([#737](https://github.com/open-artifacts-ai/open-artifacts/issues/737)) ([7416417](https://github.com/open-artifacts-ai/open-artifacts/commit/7416417eca17ee824cd3b5d95a28eebf0573ca6c))
* **setup:** six self-host setup fixes from review item 44 ([#750](https://github.com/open-artifacts-ai/open-artifacts/issues/750)) ([8388f79](https://github.com/open-artifacts-ai/open-artifacts/commit/8388f790c84594960a0006aba8d8261effae11d5))

## [0.67.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.66.2...v0.67.0) (2026-10-27)


### Features

* **brokers:** refusals after the signature verifies say stale or bad_flow ([#732](https://github.com/open-artifacts-ai/open-artifacts/issues/732)) ([a60394a](https://github.com/open-artifacts-ai/open-artifacts/commit/a60394aaaf8dff88d20166e4f80d1156d4f02ee0))

## [0.66.2](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.66.1...v0.66.2) (2026-10-27)


### Bug Fixes

* **broker-core:** rate-limit gate traffic per install, not one shared ip:unknown bucket ([#731](https://github.com/open-artifacts-ai/open-artifacts/issues/731)) ([8c89730](https://github.com/open-artifacts-ai/open-artifacts/commit/8c8973023b3dadbf6ae334b7476ebe56269c73d0))

## [0.66.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.66.0...v0.66.1) (2026-10-27)


### Performance Improvements

* **server:** publish doesn't wait on the artifact DO; the sweep recovers lost index and thumbnail jobs ([#728](https://github.com/open-artifacts-ai/open-artifacts/issues/728)) ([e3f4e99](https://github.com/open-artifacts-ai/open-artifacts/commit/e3f4e9921ab45641354317e739a21adbcfd93dc4))

## [0.66.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.65.0...v0.66.0) (2026-10-27)


### Features

* **broker-core:** gate refusals carry x-oa-gate: 1; doc codes and version skew ([#725](https://github.com/open-artifacts-ai/open-artifacts/issues/725)) ([c732aa4](https://github.com/open-artifacts-ai/open-artifacts/commit/c732aa4beacff7be67373dc9c2e493ad166ad203))
* **platform:** BrokerGate: installs reach the brokers through dispatch and scheduler props ([#720](https://github.com/open-artifacts-ai/open-artifacts/issues/720)) ([5d2162d](https://github.com/open-artifacts-ai/open-artifacts/commit/5d2162d9b5751cd6222da664fced018981921640))
* **server:** index_enqueue carries the DO's own ms (doMs) ([#727](https://github.com/open-artifacts-ai/open-artifacts/issues/727)) ([d3b6150](https://github.com/open-artifacts-ai/open-artifacts/commit/d3b6150cbb8bb5edc476956a0abdd807b78843a0))
* **server:** per-step publish timing; logs keep the runtime's support reference ([#723](https://github.com/open-artifacts-ai/open-artifacts/issues/723)) ([341f5bd](https://github.com/open-artifacts-ai/open-artifacts/commit/341f5bdf8fe36cce5ee82439ce24271e5099b055))
* **server:** reach the brokers through dispatch-props capabilities; directory sync driven by the scheduler ([#722](https://github.com/open-artifacts-ai/open-artifacts/issues/722)) ([cc1904c](https://github.com/open-artifacts-ai/open-artifacts/commit/cc1904c66baa8590c3e8ad26edd408ce26373878))

## [0.65.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.64.0...v0.65.0) (2026-10-27)


### Features

* **hosted:** redline-creds writes 0600 local copies for a local red-line run ([#711](https://github.com/open-artifacts-ai/open-artifacts/issues/711)) ([e88def5](https://github.com/open-artifacts-ai/open-artifacts/commit/e88def5f43279ff24c187bae610174d9097ded72))
* **mcp:** publish_artifact with only settings updates in place, no new version ([#681](https://github.com/open-artifacts-ai/open-artifacts/issues/681) D) ([#709](https://github.com/open-artifacts-ai/open-artifacts/issues/709)) ([1c72649](https://github.com/open-artifacts-ai/open-artifacts/commit/1c72649154c71904125efdc6356573beaf02c0f5))
* **server:** log wall ms of the publish-time index enqueue ([#717](https://github.com/open-artifacts-ai/open-artifacts/issues/717)) ([07c2fdc](https://github.com/open-artifacts-ai/open-artifacts/commit/07c2fdcbe5337c40c0da08b806f1614d18fdfdf5))


### Bug Fixes

* **redline:** sign-in capture asks for the first callback, names the r1. retry ([#713](https://github.com/open-artifacts-ai/open-artifacts/issues/713)) ([c780f98](https://github.com/open-artifacts-ai/open-artifacts/commit/c780f983912823a304a668b37ea20415b8b2d09d))

## [0.64.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.63.0...v0.64.0) (2026-10-27)


### Features

* **email:** From name is '&lt;install&gt; via Open Artifacts' on the shared sender ([#705](https://github.com/open-artifacts-ai/open-artifacts/issues/705)) ([bfea646](https://github.com/open-artifacts-ai/open-artifacts/commit/bfea646c9dad579bf1105f3ed291cb864e0c9b0a))
* **share:** "Who can change the live data" replaces Allow anonymous writes ([#681](https://github.com/open-artifacts-ai/open-artifacts/issues/681)) ([#707](https://github.com/open-artifacts-ai/open-artifacts/issues/707)) ([f59282a](https://github.com/open-artifacts-ai/open-artifacts/commit/f59282acd92a8fefe6bbeee8250a93ebb2682c21))

## [0.63.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.62.2...v0.63.0) (2026-10-27)


### Features

* dataWriters replaces allowAnonymousWrites; data_editors_only ([#681](https://github.com/open-artifacts-ai/open-artifacts/issues/681)) ([#689](https://github.com/open-artifacts-ai/open-artifacts/issues/689)) ([af92db4](https://github.com/open-artifacts-ai/open-artifacts/commit/af92db49e0af6a1d1ef5fc82531b3bad91c54206))

## [0.62.2](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.62.1...v0.62.2) (2026-10-27)


### Performance Improvements

* **viewer:** content link loads alongside the artifact's info; preconnect ([#693](https://github.com/open-artifacts-ai/open-artifacts/issues/693) part 2) ([#701](https://github.com/open-artifacts-ai/open-artifacts/issues/701)) ([698f377](https://github.com/open-artifacts-ai/open-artifacts/commit/698f3775b70496ff1850d70340ec2cc8ca2354d2))

## [0.62.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.62.0...v0.62.1) (2026-10-27)


### Bug Fixes

* **provision:** hosted installs send from the env's one sender, noreply@mail.&lt;app-zone&gt; ([#702](https://github.com/open-artifacts-ai/open-artifacts/issues/702)) ([bbb3402](https://github.com/open-artifacts-ai/open-artifacts/commit/bbb340263012f188a648856617132a35ddd06fc5))

## [0.62.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.61.0...v0.62.0) (2026-10-27)


### Features

* **api:** content-url names the version it serves ([#696](https://github.com/open-artifacts-ai/open-artifacts/issues/696)) ([dc3749b](https://github.com/open-artifacts-ai/open-artifacts/commit/dc3749b4bade2c20202ed9b9a9067d29aff91465))
* **viewer:** quiet loader and a timeout with Retry while an artifact opens ([#693](https://github.com/open-artifacts-ai/open-artifacts/issues/693)) ([#700](https://github.com/open-artifacts-ai/open-artifacts/issues/700)) ([f1434d2](https://github.com/open-artifacts-ai/open-artifacts/commit/f1434d2e5b743df095721d2d49daf0109048ac12))


### Bug Fixes

* **server:** accept the Turnstile test key by its own marker ([#697](https://github.com/open-artifacts-ai/open-artifacts/issues/697)) ([74586fe](https://github.com/open-artifacts-ai/open-artifacts/commit/74586fe92f1dd6a70b89286fdf06be9d8186ae57))
* **viewer:** never flash white while an artifact opens ([#693](https://github.com/open-artifacts-ai/open-artifacts/issues/693)) ([#695](https://github.com/open-artifacts-ai/open-artifacts/issues/695)) ([a231d68](https://github.com/open-artifacts-ai/open-artifacts/commit/a231d683f6b1d75dad967c43314269a240e7c29c))

## [0.61.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.60.0...v0.61.0) (2026-10-27)


### Features

* **hosted:** oa:hosted owner-token re-mints an install's owner PAT file ([#692](https://github.com/open-artifacts-ai/open-artifacts/issues/692)) ([714c336](https://github.com/open-artifacts-ai/open-artifacts/commit/714c336122adf94b663df716502e4a51d38c656e))

## [0.60.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.59.1...v0.60.0) (2026-10-26)


### Features

* **provision:** red-line installs get Turnstile's always-pass test pair; nothing else may ([#676](https://github.com/open-artifacts-ai/open-artifacts/issues/676)) ([b8d3014](https://github.com/open-artifacts-ai/open-artifacts/commit/b8d30144cb128afd5f2a4b07d5bec335eac5de47))
* **runtime:** subscribe says when live updates are paused (offline) ([#688](https://github.com/open-artifacts-ai/open-artifacts/issues/688)) ([1d9fcea](https://github.com/open-artifacts-ai/open-artifacts/commit/1d9fceaf743cb25004863755f7648ca52546fcc9))
* **server:** test builds accept Turnstile's test-key answer on live-hook installs only ([#677](https://github.com/open-artifacts-ai/open-artifacts/issues/677)) ([22d06d7](https://github.com/open-artifacts-ai/open-artifacts/commit/22d06d710878eaed9e8709db781bb597a83ed407))


### Bug Fixes

* **hosted:** upgrade and rollback read the env's Turnstile keys ([#683](https://github.com/open-artifacts-ai/open-artifacts/issues/683)) ([9cd19f7](https://github.com/open-artifacts-ai/open-artifacts/commit/9cd19f72420409010905bf510e31b85e13a95a34))
* **provision:** hosted assets upload with their Content-Type ([#678](https://github.com/open-artifacts-ai/open-artifacts/issues/678)) ([d505d71](https://github.com/open-artifacts-ai/open-artifacts/commit/d505d71049194e5c0e2a99f9f29ac2bcb608949b))
* **runtime:** a valid anon-id token doesn't spend the per-IP limit ([#685](https://github.com/open-artifacts-ai/open-artifacts/issues/685)) ([22f31a3](https://github.com/open-artifacts-ai/open-artifacts/commit/22f31a3fa54b811c9df53a8a94ee04e665220d36))
* **server:** /__oa/* is a JSON 404 on the app host, never the SPA shell ([#674](https://github.com/open-artifacts-ai/open-artifacts/issues/674)) ([a3283ab](https://github.com/open-artifacts-ai/open-artifacts/commit/a3283ab33723f2bef1be22aa00c010a6d3b4c561))
* **viewer:** tabs opened at once keep one anonymous id; demos handle refused writes ([#686](https://github.com/open-artifacts-ai/open-artifacts/issues/686)) ([fe30a5c](https://github.com/open-artifacts-ai/open-artifacts/commit/fe30a5cc328542aa5dac8c0e5744d8c7271d9bf8))

## [0.59.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.59.0...v0.59.1) (2026-10-26)


### Bug Fixes

* **hosted:** the CLI imports redline-creds by its .ts name, so node can load it ([#668](https://github.com/open-artifacts-ai/open-artifacts/issues/668)) ([5b5e641](https://github.com/open-artifacts-ai/open-artifacts/commit/5b5e641793106f15d1e19b9aa9533ff21372bdde))

## [0.59.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.58.3...v0.59.0) (2026-10-26)


### Features

* **hosted:** oa:hosted redline-creds sets the red-line suite's credentials ([#666](https://github.com/open-artifacts-ai/open-artifacts/issues/666)) ([43752e6](https://github.com/open-artifacts-ai/open-artifacts/commit/43752e622f1479017bc80d8b951865c7d84b2faa))

## [0.58.3](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.58.2...v0.58.3) (2026-10-26)


### Bug Fixes

* **scheduler:** a revoke that resolves to undefined is done ([#663](https://github.com/open-artifacts-ai/open-artifacts/issues/663)) ([5111d9f](https://github.com/open-artifacts-ai/open-artifacts/commit/5111d9f0fc7ff2c2734dd3a088f3a5c3300f18a1))

## [0.58.2](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.58.1...v0.58.2) (2026-10-26)


### Bug Fixes

* **release:** hosted bundles report the release version, not -dev+sha ([#660](https://github.com/open-artifacts-ai/open-artifacts/issues/660)) ([9e71e20](https://github.com/open-artifacts-ai/open-artifacts/commit/9e71e200d6e25c506acc923c50769869fabe524c))

## [0.58.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.58.0...v0.58.1) (2026-10-26)


### Bug Fixes

* **provision:** install CAS writes read RETURNING, not D1's meta.changes ([#658](https://github.com/open-artifacts-ai/open-artifacts/issues/658)) ([16a6c04](https://github.com/open-artifacts-ai/open-artifacts/commit/16a6c04b80f08a7eb61645dd8fcea482ce26cee9))

## [0.58.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.57.1...v0.58.0) (2026-10-26)


### Features

* **hosted:** delete revokes the directory grant first; purge owner email after 30 days ([#648](https://github.com/open-artifacts-ai/open-artifacts/issues/648)) ([b9f2598](https://github.com/open-artifacts-ai/open-artifacts/commit/b9f25983fa80f538bb3a123843153d0a981416e8))

## [0.57.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.57.0...v0.57.1) (2026-10-26)


### Bug Fixes

* **server:** oa:directory-disconnect keeps state and rejects on a failed revoke ([#654](https://github.com/open-artifacts-ai/open-artifacts/issues/654)) ([d3c04ea](https://github.com/open-artifacts-ai/open-artifacts/commit/d3c04ea91ac692ded14104a912f1d52e6a24ffc8))

## [0.57.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.56.0...v0.57.0) (2026-10-26)


### Features

* **inventory:** read-only HOSTS lookup for the red-line suite ([#652](https://github.com/open-artifacts-ai/open-artifacts/issues/652)) ([0f32319](https://github.com/open-artifacts-ai/open-artifacts/commit/0f32319803145e16829bc8eb69c3fa74a906006f))
* **ui:** shadcn overlays and sidebar respect reduced motion ([#260](https://github.com/open-artifacts-ai/open-artifacts/issues/260)) ([354b938](https://github.com/open-artifacts-ai/open-artifacts/commit/354b9380bfee1772f82a3652332223b9c67eef31))


### Bug Fixes

* **provision:** publish through R2's S3 API so conditional writes are enforced ([#650](https://github.com/open-artifacts-ai/open-artifacts/issues/650)) ([5e38482](https://github.com/open-artifacts-ai/open-artifacts/commit/5e384823d3c6a081876322bfa78df8423dde7200))

## [0.56.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.55.2...v0.56.0) (2026-10-26)


### Features

* **hosted:** oa:hosted CLI and the self-hosted provisioner adapter ([#636](https://github.com/open-artifacts-ai/open-artifacts/issues/636)) ([0d178cf](https://github.com/open-artifacts-ai/open-artifacts/commit/0d178cff556c83cc2099579641b694679bcd6e49))
* **provision:** hosted installs always have spaces on ([#634](https://github.com/open-artifacts-ai/open-artifacts/issues/634)) ([7a0dd62](https://github.com/open-artifacts-ai/open-artifacts/commit/7a0dd62771365370fb7a32bae4e82d8f751f5461))
* **server:** read-only POST /__test/audit hook ([#642](https://github.com/open-artifacts-ai/open-artifacts/issues/642)) ([7df1171](https://github.com/open-artifacts-ai/open-artifacts/commit/7df1171c9831cfac9455018f7d3ab68afc940354))

## [0.55.2](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.55.1...v0.55.2) (2026-10-25)


### Bug Fixes

* **setup:** no step requires Access vars or the Access secret when access isn't in AUTH_PROVIDERS ([#632](https://github.com/open-artifacts-ai/open-artifacts/issues/632)) ([7ffa990](https://github.com/open-artifacts-ai/open-artifacts/commit/7ffa990481bb29202bfbc9649757eaad0bd28853))

## [0.55.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.55.0...v0.55.1) (2026-10-25)


### Bug Fixes

* **setup:** the access step is done (not needed) when access isn't in AUTH_PROVIDERS ([#629](https://github.com/open-artifacts-ai/open-artifacts/issues/629)) ([e2f83f3](https://github.com/open-artifacts-ai/open-artifacts/commit/e2f83f32fe4e31bafa858351ffd94b74ba79cd46))

## [0.55.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.54.0...v0.55.0) (2026-10-25)


### Features

* self-host Geist, no Google Fonts anywhere ([#625](https://github.com/open-artifacts-ai/open-artifacts/issues/625)) ([a670e16](https://github.com/open-artifacts-ai/open-artifacts/commit/a670e16d531a577662f36c6b22a1119553a2e13b))

## [0.54.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.53.0...v0.54.0) (2026-10-25)


### Features

* **server:** owner-only directory disconnect plus platform system job ([#616](https://github.com/open-artifacts-ai/open-artifacts/issues/616)) ([a4e1f2e](https://github.com/open-artifacts-ai/open-artifacts/commit/a4e1f2e027c443eee27f2716b71c41e877aed842))

## [0.53.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.52.0...v0.53.0) (2026-10-25)


### Features

* **server:** delete audit events past 400 days in the daily cron ([#615](https://github.com/open-artifacts-ai/open-artifacts/issues/615)) ([17eac9f](https://github.com/open-artifacts-ai/open-artifacts/commit/17eac9fa41cd3cbaaab7f32ded124ab6158046eb))


### Bug Fixes

* **auth:** a revoked session on the break-glass card goes to sign-in ([#612](https://github.com/open-artifacts-ai/open-artifacts/issues/612)) ([5279834](https://github.com/open-artifacts-ai/open-artifacts/commit/52798342a8131d84b17017137bfeee5594f24b9d))

## [0.52.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.51.0...v0.52.0) (2026-10-25)


### Features

* **auth:** directory break-glass card for the locked-out owner ([#611](https://github.com/open-artifacts-ai/open-artifacts/issues/611)) ([6b25371](https://github.com/open-artifacts-ai/open-artifacts/commit/6b2537184ce093e270163f917f696f2dd7979c37))

## [0.51.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.50.0...v0.51.0) (2026-10-25)


### Features

* **server:** feature flags; frozen never widens (P3 T15) ([#596](https://github.com/open-artifacts-ai/open-artifacts/issues/596)) ([ead056a](https://github.com/open-artifacts-ai/open-artifacts/commit/ead056a3154a401fab3001d4d15ee827d32570e2))
* **server:** usage_off feature flag (P3 T19) ([#603](https://github.com/open-artifacts-ai/open-artifacts/issues/603)) ([4d005a7](https://github.com/open-artifacts-ai/open-artifacts/commit/4d005a7830c558e27c1e2a30fa75d24e50255ef6))


### Bug Fixes

* **server:** a restricted member's PAT is refused at /mcp ([#606](https://github.com/open-artifacts-ai/open-artifacts/issues/606)) ([3ab8b1e](https://github.com/open-artifacts-ai/open-artifacts/commit/3ab8b1e162c18e02ca2aef300ea0105364d6f364))

## [0.50.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.49.0...v0.50.0) (2026-10-25)


### Features

* **server:** GET /me answers break_glass_required for the mismatch owner (P3 T18) ([#599](https://github.com/open-artifacts-ai/open-artifacts/issues/599)) ([6300906](https://github.com/open-artifacts-ai/open-artifacts/commit/63009062e79ec1a4e76687bacbd6556d187e350d))

## [0.49.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.48.0...v0.49.0) (2026-10-25)


### Features

* **server:** informational staleAt, session cap, break-glass (P3 T18) ([#597](https://github.com/open-artifacts-ai/open-artifacts/issues/597)) ([3bdd08c](https://github.com/open-artifacts-ai/open-artifacts/commit/3bdd08ca81c6dc6dc5e1b9ebed5cde6f06f18318))

## [0.48.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.47.1...v0.48.0) (2026-10-25)


### Features

* **server:** apply directory state by identity, never by email (P3 T14) ([#592](https://github.com/open-artifacts-ai/open-artifacts/issues/592)) ([60ba7df](https://github.com/open-artifacts-ai/open-artifacts/commit/60ba7df27cebf04047b2b2020016088f804841b5))

## [0.47.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.47.0...v0.47.1) (2026-10-25)


### Bug Fixes

* **server:** actions on an org admin are owner-only ([#475](https://github.com/open-artifacts-ai/open-artifacts/issues/475)) ([#553](https://github.com/open-artifacts-ai/open-artifacts/issues/553)) ([75e9c8f](https://github.com/open-artifacts-ai/open-artifacts/commit/75e9c8f311acb6f455c1e4c5ecdcf3cf086aadf8))
* **server:** deriveKey refuses content key labels at runtime ([#591](https://github.com/open-artifacts-ai/open-artifacts/issues/591)) ([977391c](https://github.com/open-artifacts-ai/open-artifacts/commit/977391cf63b6c3506f2ec2e11a666daf1a69e18b))

## [0.47.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.46.0...v0.47.0) (2026-10-25)


### Features

* **dashboard:** handle the 409 conflict on Details, Move and Share visibility ([#586](https://github.com/open-artifacts-ai/open-artifacts/issues/586)) ([44978df](https://github.com/open-artifacts-ai/open-artifacts/commit/44978dfabc30ee8a8bb10fea69676ee98cf81785))
* **provision:** carry the install's domains into both registry copies ([#582](https://github.com/open-artifacts-ai/open-artifacts/issues/582)) ([c9d12f6](https://github.com/open-artifacts-ai/open-artifacts/commit/c9d12f6aafe791d1c507f1a217ad24df1372efa1))
* **server:** DirectorySync polling, reconcile and health (P3 T13) ([#575](https://github.com/open-artifacts-ai/open-artifacts/issues/575)) ([f1180d3](https://github.com/open-artifacts-ai/open-artifacts/commit/f1180d3a174a4e7b225a64a7c94d0e89264e4c37))
* **settings:** agent identity cards for connected agents ([#587](https://github.com/open-artifacts-ai/open-artifacts/issues/587)) ([d6847e5](https://github.com/open-artifacts-ai/open-artifacts/commit/d6847e5da47fc9b2979ee087eafdf3387e5fe94e))
* **settings:** the directory connect confirm step ([#580](https://github.com/open-artifacts-ai/open-artifacts/issues/580)) ([4d76fe2](https://github.com/open-artifacts-ai/open-artifacts/commit/4d76fe253580d1814d4498ee4f92cfb28bf64fec))


### Bug Fixes

* **settings:** a non-owner's pending line reads "Expires", not "Confirm by" ([#588](https://github.com/open-artifacts-ai/open-artifacts/issues/588)) ([7f94aa8](https://github.com/open-artifacts-ai/open-artifacts/commit/7f94aa8a52cf7bbfc26484bebdb6a2710a8b6e9e))

## [0.46.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.45.0...v0.46.0) (2026-10-24)


### Features

* **directory-broker:** per-env config test and deploy wiring ([#579](https://github.com/open-artifacts-ai/open-artifacts/issues/579)) ([bd4a784](https://github.com/open-artifacts-ai/open-artifacts/commit/bd4a784e08eb949b89e3c7b657f09e96e0770f22))
* **server:** directory connection via a separate directory broker (P3 T12) ([#564](https://github.com/open-artifacts-ai/open-artifacts/issues/564)) ([45890f3](https://github.com/open-artifacts-ai/open-artifacts/commit/45890f35c9082ccc5fc6ee6c09cd6fbdb5e31fac))
* **server:** DirectorySync DO class and binding, inert (P3 T13a) ([#571](https://github.com/open-artifacts-ai/open-artifacts/issues/571)) ([da64a86](https://github.com/open-artifacts-ai/open-artifacts/commit/da64a864df54a455ec3a274b6a9a998cb3d2186d))
* **server:** identity cards for connected agents ([#559](https://github.com/open-artifacts-ai/open-artifacts/issues/559)) ([d4b509f](https://github.com/open-artifacts-ai/open-artifacts/commit/d4b509f2fc8f4633a0c864cc2bea088883902449))


### Bug Fixes

* **provision:** hosted installs always join by invite ([#573](https://github.com/open-artifacts-ai/open-artifacts/issues/573)) ([8a2b9f8](https://github.com/open-artifacts-ai/open-artifacts/commit/8a2b9f86233e987dfbcdecce72842d7440694631))
* **provision:** refuse a Cloudflare token within 5 days of expiry ([#547](https://github.com/open-artifacts-ai/open-artifacts/issues/547)) ([e0691f4](https://github.com/open-artifacts-ai/open-artifacts/commit/e0691f44916cc3059bc14fab0d696b1a9b83d036))
* **provision:** write the registry under install:&lt;id&gt;, the key the broker reads ([#566](https://github.com/open-artifacts-ai/open-artifacts/issues/566)) ([09f4855](https://github.com/open-artifacts-ai/open-artifacts/commit/09f48556dc41a94439cced0f0995bd7221cce0a0))
* **server:** hosted installs admit by invite only ([#574](https://github.com/open-artifacts-ai/open-artifacts/issues/574)) ([e0c2386](https://github.com/open-artifacts-ai/open-artifacts/commit/e0c23860c29d62c45259417ff0d02c011afd0bb9))

## [0.45.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.44.0...v0.45.0) (2026-10-24)


### Features

* **auth-broker:** per-env config for staging and prod ([#561](https://github.com/open-artifacts-ai/open-artifacts/issues/561)) ([3d97d90](https://github.com/open-artifacts-ai/open-artifacts/commit/3d97d904c0eb31a3b6ac48adf009f80135efccca))
* **dashboard:** validate space names, say when a group's access just changed ([#550](https://github.com/open-artifacts-ai/open-artifacts/issues/550)) ([a3e5917](https://github.com/open-artifacts-ai/open-artifacts/commit/a3e5917fd7de58b4c219068ca96bb8e4ea2500e3))


### Bug Fixes

* **provision:** reserve the directory slug ([#562](https://github.com/open-artifacts-ai/open-artifacts/issues/562)) ([0edad66](https://github.com/open-artifacts-ai/open-artifacts/commit/0edad66a1d14d03bd20ecf96807073eae1467e1e))

## [0.44.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.43.0...v0.44.0) (2026-10-24)


### Features

* **landing:** hero leads with Open Artifacts; Cloudflare only for self-host ([#421](https://github.com/open-artifacts-ai/open-artifacts/issues/421)) ([#554](https://github.com/open-artifacts-ai/open-artifacts/issues/554)) ([7d57ef5](https://github.com/open-artifacts-ai/open-artifacts/commit/7d57ef50bfb5cad12fa2377fe4b6adaa75b5d7f4))
* **server:** content host revocation in D1 (P3 T11) ([#544](https://github.com/open-artifacts-ai/open-artifacts/issues/544)) ([b7720e7](https://github.com/open-artifacts-ai/open-artifacts/commit/b7720e70a2aaf8535aa8bdfd093444a0b71f8f96))
* **server:** publish into spaces, move, transfer, MCP (P3 T10) ([#534](https://github.com/open-artifacts-ai/open-artifacts/issues/534)) ([13dc9d0](https://github.com/open-artifacts-ai/open-artifacts/commit/13dc9d0d9c65b1e77bd7fd5e8106dec0aa7739d7))


### Bug Fixes

* **ops:** the signing key script no longer requires a prod reviewer ([#545](https://github.com/open-artifacts-ai/open-artifacts/issues/545)) ([b507e93](https://github.com/open-artifacts-ai/open-artifacts/commit/b507e937f32bb8a6e2bddef1e0a8c9c673d6bff8))
* **viewer:** a live swap keeps the exact offset when it fits; re-report after restore and on resize ([#546](https://github.com/open-artifacts-ai/open-artifacts/issues/546)) ([c3d4fc1](https://github.com/open-artifacts-ai/open-artifacts/commit/c3d4fc1fcc28cca1557f0c55bcaf7fa1d5c8ae28))

## [0.43.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.42.0...v0.43.0) (2026-10-24)


### Features

* **server:** spaces API and space-wide narrowing (P3 T9) ([#527](https://github.com/open-artifacts-ai/open-artifacts/issues/527)) ([c0c5ada](https://github.com/open-artifacts-ai/open-artifacts/commit/c0c5adac24e898ae6be74e37f561df1ddea57da5))


### Bug Fixes

* **viewer:** live versions swap while you scroll or have the panel open, and keep your place ([#542](https://github.com/open-artifacts-ai/open-artifacts/issues/542)) ([9bf0d41](https://github.com/open-artifacts-ai/open-artifacts/commit/9bf0d41a597795c0d05ed88ce76efea4504b0a0a))

## [0.42.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.41.0...v0.42.0) (2026-10-24)


### Features

* **provision:** pin the release signing public keys; refuse a key while unpinned ([#536](https://github.com/open-artifacts-ai/open-artifacts/issues/536)) ([7f96e7e](https://github.com/open-artifacts-ai/open-artifacts/commit/7f96e7e94496e01844be5229b9df8bef96b51950))
* **scheduler:** nightly jobs for hosted installs ([#531](https://github.com/open-artifacts-ai/open-artifacts/issues/531)) ([390b17f](https://github.com/open-artifacts-ai/open-artifacts/commit/390b17fd4fda03fa1e5aa352f412f2e7ca8bd8f6))
* **server:** per-user presence closes live sockets (P3 T7b) ([#503](https://github.com/open-artifacts-ai/open-artifacts/issues/503)) ([5061994](https://github.com/open-artifacts-ai/open-artifacts/commit/5061994d086401b8d92e78c34d7e825bfb2a165a))
* **server:** user status, admission seam with P2 (P3 T6) ([#515](https://github.com/open-artifacts-ai/open-artifacts/issues/515)) ([ed48a9b](https://github.com/open-artifacts-ai/open-artifacts/commit/ed48a9b5420ff587b754c85a96bb149c8b4582b6))

## [0.41.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.40.1...v0.41.0) (2026-10-24)


### Features

* **server:** UserPresence DO class, unused (P3 T7a) ([#502](https://github.com/open-artifacts-ai/open-artifacts/issues/502)) ([11155de](https://github.com/open-artifacts-ai/open-artifacts/commit/11155de3cd4e9b655d87f5b726f9acd144222999))


### Bug Fixes

* **server:** answer only the configured app and content hosts ([#518](https://github.com/open-artifacts-ai/open-artifacts/issues/518)) ([1681e10](https://github.com/open-artifacts-ai/open-artifacts/commit/1681e10a83cfa88065a44f3e61c4c936764ac28d))
* **viewer:** links to app pages are blocked in place with a note ([#525](https://github.com/open-artifacts-ai/open-artifacts/issues/525)) ([#530](https://github.com/open-artifacts-ai/open-artifacts/issues/530)) ([dd9b3e5](https://github.com/open-artifacts-ai/open-artifacts/commit/dd9b3e58d252bae443e4ff248a90e7c699a7e7c1))

## [0.40.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.40.0...v0.40.1) (2026-10-24)


### Bug Fixes

* **viewer:** in-artifact links: /a/ in place, external links in the same tab via the shell (P0) ([#512](https://github.com/open-artifacts-ai/open-artifacts/issues/512)) ([3012b51](https://github.com/open-artifacts-ai/open-artifacts/commit/3012b51447e9be8664b75d07450f226b051bd39b))

## [0.40.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.39.0...v0.40.0) (2026-10-24)


### Features

* **provision:** upgrade, rollback and delete for hosted installs ([#490](https://github.com/open-artifacts-ai/open-artifacts/issues/490)) ([5815742](https://github.com/open-artifacts-ai/open-artifacts/commit/58157423ccb8ba28f553fd1d96def9c6a44a88b8))

## [0.39.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.38.0...v0.39.0) (2026-10-23)


### Features

* **server:** audit events incl. shares, visibility and sign-ins (P3 T8) ([#501](https://github.com/open-artifacts-ai/open-artifacts/issues/501)) ([0c632e0](https://github.com/open-artifacts-ai/open-artifacts/commit/0c632e056153affe222986f6807bea2aa2dbac6d))

## [0.38.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.37.0...v0.38.0) (2026-10-23)


### Features

* **ui:** shadcn Alert tones, Textarea, Checkbox and Kbd ([#507](https://github.com/open-artifacts-ai/open-artifacts/issues/507)) ([df1f81d](https://github.com/open-artifacts-ai/open-artifacts/commit/df1f81d276dfb6073cdb577708426eaddaa41c55))

## [0.37.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.36.0...v0.37.0) (2026-10-23)


### Features

* **layout:** sync-health banner; hide usage when off (P4 T4) ([#441](https://github.com/open-artifacts-ai/open-artifacts/issues/441)) ([0af3b3b](https://github.com/open-artifacts-ai/open-artifacts/commit/0af3b3b94266949105ebaf0284d7919792142ac5))
* **viewer:** one versions control, the chip opens a searchable Versions panel ([#471](https://github.com/open-artifacts-ai/open-artifacts/issues/471)) ([#494](https://github.com/open-artifacts-ai/open-artifacts/issues/494)) ([d303c96](https://github.com/open-artifacts-ai/open-artifacts/commit/d303c96b5a3b4342330df6026127ef49c52adf87))

## [0.36.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.35.0...v0.36.0) (2026-10-23)


### Features

* **dashboard:** reset a member's Google link (P4 Task 16) ([#452](https://github.com/open-artifacts-ai/open-artifacts/issues/452)) ([0b3595e](https://github.com/open-artifacts-ai/open-artifacts/commit/0b3595edf3c86932f11b7cb153e62112577413e7))
* **dashboard:** say access is gone on a space-scoped 404 ([#491](https://github.com/open-artifacts-ai/open-artifacts/issues/491)) ([9a0e93b](https://github.com/open-artifacts-ai/open-artifacts/commit/9a0e93b4feff65477fbb6ac49e3dd21922b8e85f))


### Bug Fixes

* **copy:** say manually, not by hand ([#487](https://github.com/open-artifacts-ai/open-artifacts/issues/487)) ([d0c0905](https://github.com/open-artifacts-ai/open-artifacts/commit/d0c090567970f6e8a3192e4d74540a925247f556))
* **release:** deploy-prod's test-hooks check gets its temp dir under --ci; hosted signing skips before the key ceremony ([#495](https://github.com/open-artifacts-ai/open-artifacts/issues/495)) ([ea3db24](https://github.com/open-artifacts-ai/open-artifacts/commit/ea3db24f5a213a189418b9c81a58d0093d8384b7))
* **shared:** Google-linked hosted mock members have a lastSeenAt ([#496](https://github.com/open-artifacts-ai/open-artifacts/issues/496)) ([c26a40a](https://github.com/open-artifacts-ai/open-artifacts/commit/c26a40a25e548deaee636f1e5c0bc9b6d80ceeb2))

## [0.35.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.34.0...v0.35.0) (2026-10-23)


### Features

* **dashboard:** transfer a departed person's artifacts (P4 Task 13) ([#457](https://github.com/open-artifacts-ai/open-artifacts/issues/457)) ([d8c15a5](https://github.com/open-artifacts-ai/open-artifacts/commit/d8c15a51432c5d1af5ef7cb8b6d905a4fadf4cdf))
* **provision:** release signer, R2 release reader, signed floor (T3b) ([#468](https://github.com/open-artifacts-ai/open-artifacts/issues/468)) ([64396fb](https://github.com/open-artifacts-ai/open-artifacts/commit/64396fbd906bfbbe3c851f1d30c9df185dbbfc47))
* **server:** space-aware list and search with SQL levels (P3 T4) ([#481](https://github.com/open-artifacts-ai/open-artifacts/issues/481)) ([96f9c6c](https://github.com/open-artifacts-ai/open-artifacts/commit/96f9c6c93a554e6017200e970a1fcb62ef4978e5))

## [0.34.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.33.1...v0.34.0) (2026-10-23)


### Features

* **auth-broker:** stateless Google broker returning raw ID tokens (P2 T11) ([#396](https://github.com/open-artifacts-ai/open-artifacts/issues/396)) ([ebc04f2](https://github.com/open-artifacts-ai/open-artifacts/commit/ebc04f28ffa53ee58429e685e5fdc61674809169))
* **dashboard:** space People, manual and synced (P4 Task 12) ([#465](https://github.com/open-artifacts-ai/open-artifacts/issues/465)) ([fce185c](https://github.com/open-artifacts-ai/open-artifacts/commit/fce185cd70e3c6c4314a4dd5da0afb298e308b77))
* **dashboard:** spaces admin, group mappings, Every space and manager mapping (P4 Tasks 10, 11) ([#443](https://github.com/open-artifacts-ai/open-artifacts/issues/443)) ([0ced676](https://github.com/open-artifacts-ai/open-artifacts/commit/0ced6764452cf8d55d90f6308afe56536274208f))
* **dashboard:** View only chip for read-only viewers (P4 D10) ([#428](https://github.com/open-artifacts-ai/open-artifacts/issues/428)) ([6f36f58](https://github.com/open-artifacts-ai/open-artifacts/commit/6f36f580bd6b4b705dcd788bffeb081e47c6e0ff))
* **shared:** Google-linked members in hosted mocks; owner_only for admin link resets ([#453](https://github.com/open-artifacts-ai/open-artifacts/issues/453)) ([6a6ac8d](https://github.com/open-artifacts-ai/open-artifacts/commit/6a6ac8d716add42ad64cd4104db48adf32221f34))


### Bug Fixes

* **auth:** only the owner can reset an admin's Google link (owner_only) ([#474](https://github.com/open-artifacts-ai/open-artifacts/issues/474)) ([ba3962a](https://github.com/open-artifacts-ai/open-artifacts/commit/ba3962a75a062091cd0859af12c83404b5dfe4fe))

## [0.33.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.33.0...v0.33.1) (2026-10-23)


### Bug Fixes

* **ci:** skip deploy-prod with a notice when prod isn't installed ([#172](https://github.com/open-artifacts-ai/open-artifacts/issues/172)) ([#404](https://github.com/open-artifacts-ai/open-artifacts/issues/404)) ([05deecd](https://github.com/open-artifacts-ai/open-artifacts/commit/05deecd069238a9e5832ff02eae4529e3518cd72))
* **library:** ?space= is the library's only on library routes ([#464](https://github.com/open-artifacts-ai/open-artifacts/issues/464)) ([25cd366](https://github.com/open-artifacts-ai/open-artifacts/commit/25cd36686187690dd66ea657d3835189be61ca2d))
* **shared:** hosted mocks list by space (scope=space and spaces) ([#449](https://github.com/open-artifacts-ai/open-artifacts/issues/449)) ([97ef69a](https://github.com/open-artifacts-ai/open-artifacts/commit/97ef69ac9aff01a0661d673bc76adf31594ba5cb))

## [0.33.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.32.0...v0.33.0) (2026-10-22)


### Features

* **dashboard:** choose a space when uploading (P4 Task 7) ([#451](https://github.com/open-artifacts-ai/open-artifacts/issues/451)) ([32354a7](https://github.com/open-artifacts-ai/open-artifacts/commit/32354a788b22e11dfc7bea9f6f3af5bea9b2c8f0))

## [0.32.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.31.0...v0.32.0) (2026-10-22)


### Features

* **test-hooks:** gated /__test/* hooks for the cross-tenant suite (P2 T14) ([#393](https://github.com/open-artifacts-ai/open-artifacts/issues/393)) ([de85313](https://github.com/open-artifacts-ai/open-artifacts/commit/de8531398886bfc43d1f0348a7875a73d936aaac))

## [0.31.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.30.0...v0.31.0) (2026-10-22)


### Features

* **auth:** sign-in events and CPU budgets (P2 T10) ([#389](https://github.com/open-artifacts-ai/open-artifacts/issues/389)) ([2adcf13](https://github.com/open-artifacts-ai/open-artifacts/commit/2adcf13da8f92d7a551732e455d5599ceeed0724))
* **dashboard:** spaces in the sidebar and the space marker (P4 Task 6) ([#448](https://github.com/open-artifacts-ai/open-artifacts/issues/448)) ([7efcdac](https://github.com/open-artifacts-ai/open-artifacts/commit/7efcdacb06606375f91e16ac5c71adbba33531b1))

## [0.30.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.29.0...v0.30.0) (2026-10-22)


### Features

* **authz:** guests are read-only under direct sign-in (P2 T9) ([#386](https://github.com/open-artifacts-ai/open-artifacts/issues/386)) ([8648244](https://github.com/open-artifacts-ai/open-artifacts/commit/8648244fd6edfe0ddf4f3c3f97e6e20ce3d42cc4))

## [0.29.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.28.0...v0.29.0) (2026-10-22)


### Features

* **auth:** code sign-in routes (P2 T8) ([#384](https://github.com/open-artifacts-ai/open-artifacts/issues/384)) ([91e6d64](https://github.com/open-artifacts-ai/open-artifacts/commit/91e6d64b03efd9b015fb0282196fefdbd031c668))
* **dashboard:** public links off per space in the Share panel (P4 Task 9) ([#445](https://github.com/open-artifacts-ai/open-artifacts/issues/445)) ([1963354](https://github.com/open-artifacts-ai/open-artifacts/commit/1963354eacb785fcc7a917bc735a6b70f77e456c))
* **shared:** space People contract: member manager rule, frozen-sync removal, groups role/via, paging, member_synced, allMembers ([#446](https://github.com/open-artifacts-ai/open-artifacts/issues/446)) ([598650c](https://github.com/open-artifacts-ai/open-artifacts/commit/598650c83856f3ec9fc34ab0ded1b20c6e697b8a))
* **shared:** space-manager mappings, org Every-space mappings, directory_mapping_off (contract) ([#422](https://github.com/open-artifacts-ai/open-artifacts/issues/422)) ([f360744](https://github.com/open-artifacts-ai/open-artifacts/commit/f3607443e79bd8e3bcd7eea31735249d686f8892))

## [0.28.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.27.0...v0.28.0) (2026-10-22)


### Features

* **auth:** providers endpoint, Google sign-in routes, Me sign-in fields (P2 T6) ([#380](https://github.com/open-artifacts-ai/open-artifacts/issues/380)) ([8221a95](https://github.com/open-artifacts-ai/open-artifacts/commit/8221a95ac9df1717a5a69e35c02d1c412ee741a9))

## [0.27.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.26.1...v0.27.0) (2026-10-22)


### Features

* **auth:** admission, linking and code eligibility (P2 T5) ([#375](https://github.com/open-artifacts-ai/open-artifacts/issues/375)) ([8a34089](https://github.com/open-artifacts-ai/open-artifacts/commit/8a34089b1f3bb0d3a700be43180db0cbff6579b8))
* **dashboard:** Google directory page, held sweeps and restricted groups (P4 Tasks 17, 18) ([#437](https://github.com/open-artifacts-ai/open-artifacts/issues/437)) ([70f7439](https://github.com/open-artifacts-ai/open-artifacts/commit/70f74396fe81045d771030ca17c77312f14db995))
* **dashboard:** restricted members, badge plus row menu (P4 Task 15) ([#439](https://github.com/open-artifacts-ai/open-artifacts/issues/439)) ([393103b](https://github.com/open-artifacts-ai/open-artifacts/commit/393103b668aa930b3adaf84bae5143c729e77191))

## [0.26.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.26.0...v0.26.1) (2026-10-22)


### Bug Fixes

* **provision:** signed release records cover assets, template and migrations; prod locked ([#426](https://github.com/open-artifacts-ai/open-artifacts/issues/426) review) ([#435](https://github.com/open-artifacts-ai/open-artifacts/issues/435)) ([1d06125](https://github.com/open-artifacts-ai/open-artifacts/commit/1d061253991b7923367de691d46d42ba4d0281e1))

## [0.26.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.25.0...v0.26.0) (2026-10-22)


### Features

* **dashboard:** hosted sign-in, Google plus emailed codes (P4 Task 14) ([#430](https://github.com/open-artifacts-ai/open-artifacts/issues/430)) ([e77e183](https://github.com/open-artifacts-ai/open-artifacts/commit/e77e183fdf0dcdcf10640699ca01eddd23bdd41a))

## [0.25.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.24.0...v0.25.0) (2026-10-22)


### Features

* **auth:** Google ID token verification and the direct transport (P2 T4) ([#372](https://github.com/open-artifacts-ai/open-artifacts/issues/372)) ([d79438c](https://github.com/open-artifacts-ai/open-artifacts/commit/d79438c6cb577611ed0dd23363717719112d6472))

## [0.24.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.23.1...v0.24.0) (2026-10-22)


### Features

* **auth:** provider interface, derived-key cookies, session epoch and tenant (P2 T2) ([#369](https://github.com/open-artifacts-ai/open-artifacts/issues/369)) ([2a6534f](https://github.com/open-artifacts-ai/open-artifacts/commit/2a6534fcba8358339614867742d251c334b138bf))
* **provision:** WfpProvisioner.create on Workers for Platforms ([#426](https://github.com/open-artifacts-ai/open-artifacts/issues/426)) ([635a08f](https://github.com/open-artifacts-ai/open-artifacts/commit/635a08f4be9bd36f048b4de3b19ba4fba2d7e2e6))

## [0.23.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.23.0...v0.23.1) (2026-10-22)


### Bug Fixes

* **dashboard:** making an artifact public keeps anonymous writes on ([#418](https://github.com/open-artifacts-ai/open-artifacts/issues/418)) ([#419](https://github.com/open-artifacts-ai/open-artifacts/issues/419)) ([7ad1b14](https://github.com/open-artifacts-ai/open-artifacts/commit/7ad1b149db46f992ab6fa51cce0bb0ea278f629d))
* **server:** answer only the configured app and content hosts (P1 6b) ([#415](https://github.com/open-artifacts-ai/open-artifacts/issues/415)) ([c060b0a](https://github.com/open-artifacts-ai/open-artifacts/commit/c060b0aecd2e5307c4d137462576866f377adb7d))
* **setup:** exact welcome lookup, no ownership moves on --upgrade ([#417](https://github.com/open-artifacts-ai/open-artifacts/issues/417)) ([38c214a](https://github.com/open-artifacts-ai/open-artifacts/commit/38c214ad268bac91a406d64041679778954c491a))

## [0.23.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.22.0...v0.23.0) (2026-10-21)


### Features

* **dashboard:** hosted P4 permissions from can (Task 3) ([#382](https://github.com/open-artifacts-ai/open-artifacts/issues/382)) ([a8ea6fb](https://github.com/open-artifacts-ai/open-artifacts/commit/a8ea6fbec5b46790bc5cd33f723d14f1e90a7a2a))
* **dashboard:** restrict_admin and code_unavailable error copy ([#399](https://github.com/open-artifacts-ai/open-artifacts/issues/399)) ([2d3a7cb](https://github.com/open-artifacts-ai/open-artifacts/commit/2d3a7cbfde02947fedf1f1d6297c7f0b6d8031b2))
* **library:** space filter in the URL and query (P4 Task 5) ([#416](https://github.com/open-artifacts-ai/open-artifacts/issues/416)) ([88b202c](https://github.com/open-artifacts-ai/open-artifacts/commit/88b202c8199490020bc3acd5491103d4179b409c))
* **ops:** prod setup switches to team email (mail.leourbina.com) ([#409](https://github.com/open-artifacts-ai/open-artifacts/issues/409)) ([58dd2ac](https://github.com/open-artifacts-ai/open-artifacts/commit/58dd2ac9daf53a2a0dec505f2ef0a5844dfedc2c))
* **server:** report installId on /healthz for hosted installs (P1 6b) ([#410](https://github.com/open-artifacts-ai/open-artifacts/issues/410)) ([b993fee](https://github.com/open-artifacts-ai/open-artifacts/commit/b993feeeb13cb7eb85ec7689f853d2ddc2a68f86))
* **server:** RL_AUTH ratelimit binding for direct sign-in ([#385](https://github.com/open-artifacts-ai/open-artifacts/issues/385)) ([0ea22ce](https://github.com/open-artifacts-ai/open-artifacts/commit/0ea22ce82ea8a4e20ffd6c7f7286f8fee03f4b84))
* **spaces:** spaces schema, personal space per user (P3 T1) ([#408](https://github.com/open-artifacts-ai/open-artifacts/issues/408)) ([b67aa9b](https://github.com/open-artifacts-ai/open-artifacts/commit/b67aa9b31155974f5ca953ea0d86368d658fa869))


### Bug Fixes

* **demo:** heartbeat seats, adopted writes and visible errors in the real-time demos ([#413](https://github.com/open-artifacts-ai/open-artifacts/issues/413)) ([63d8061](https://github.com/open-artifacts-ai/open-artifacts/commit/63d8061fedc472f1d3a30e17feb7bc71e114c080))
* **setup:** run the full MCP selftest on CI upgrades ([#171](https://github.com/open-artifacts-ai/open-artifacts/issues/171)) ([#403](https://github.com/open-artifacts-ai/open-artifacts/issues/403)) ([f4e9862](https://github.com/open-artifacts-ai/open-artifacts/commit/f4e986249b14155a62b7124a707d7e3d1ea9d17a))

## [0.22.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.21.0...v0.22.0) (2026-10-21)


### Features

* **db:** identities, login_codes, users.session_epoch and status (0008, P2 T3) ([#368](https://github.com/open-artifacts-ai/open-artifacts/issues/368)) ([4eccd8e](https://github.com/open-artifacts-ai/open-artifacts/commit/4eccd8e3730972604ba2dd3bf418dd546be00a4a))
* **provision:** env-prefixed names and the foreign-resource guard ([#402](https://github.com/open-artifacts-ai/open-artifacts/issues/402)) ([c1ef1fe](https://github.com/open-artifacts-ai/open-artifacts/commit/c1ef1fe85d17325f2040b16930f8fd393f12d9e1))

## [0.21.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.20.0...v0.21.0) (2026-10-21)


### Features

* **provision:** user Worker bundle and upload metadata ([#391](https://github.com/open-artifacts-ai/open-artifacts/issues/391)) ([b78cb5c](https://github.com/open-artifacts-ai/open-artifacts/commit/b78cb5c81eee2b82958e867580c9a361288e743e))
* **server:** enforce route and tool policy before handlers (P3 T5) ([#374](https://github.com/open-artifacts-ai/open-artifacts/issues/374)) ([19c5de9](https://github.com/open-artifacts-ai/open-artifacts/commit/19c5de95a4d7c57b2ac3cd4f74830df986affb71))
* **viewer:** live version updates (option B: safe swap, otherwise the chip) ([#349](https://github.com/open-artifacts-ai/open-artifacts/issues/349)) ([00c9d44](https://github.com/open-artifacts-ai/open-artifacts/commit/00c9d44ff69a8bab05726ad9b3493163160a87da))

## [0.20.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.19.0...v0.20.0) (2026-10-21)


### Features

* **server:** authorize(action) over the decision table (P3 T3) ([#367](https://github.com/open-artifacts-ai/open-artifacts/issues/367)) ([92c35cc](https://github.com/open-artifacts-ai/open-artifacts/commit/92c35ccc108c555feee8d8fb06d9e39d6745ffc9))


### Bug Fixes

* **provision:** reserve auth, broker, login and sso slugs ([#397](https://github.com/open-artifacts-ai/open-artifacts/issues/397)) ([77707da](https://github.com/open-artifacts-ai/open-artifacts/commit/77707da5d4b7069b78b45c93881b9358b1491125))

## [0.19.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.18.0...v0.19.0) (2026-10-20)


### Features

* **auth:** direct sign-in config contract, domain parsing, HKDF keys (P2 T1) ([#366](https://github.com/open-artifacts-ai/open-artifacts/issues/366)) ([c7adf42](https://github.com/open-artifacts-ai/open-artifacts/commit/c7adf42ad2d9f1f16fa534d48450f202cefd7a20))
* **dashboard:** hosted P4 foundation (contract adapter, safeNext, error copy, reauth) ([#376](https://github.com/open-artifacts-ai/open-artifacts/issues/376)) ([e3b872e](https://github.com/open-artifacts-ai/open-artifacts/commit/e3b872e6e66b88eb7db0fdf9c856bbf297625984))
* **server:** central access decision table (P3 T2) ([#365](https://github.com/open-artifacts-ai/open-artifacts/issues/365)) ([7502394](https://github.com/open-artifacts-ai/open-artifacts/commit/750239415e28669e25646c6657703bf6380c2b58))
* **shared:** export HostedMockOptions from the mocks entry ([#377](https://github.com/open-artifacts-ai/open-artifacts/issues/377)) ([ef319cc](https://github.com/open-artifacts-ai/open-artifacts/commit/ef319cca72951c3445db880d7ef248ff623635b8))


### Bug Fixes

* **shared:** hosted contract follow-ups (move into publicLinks-off space, restrict_admin) ([#370](https://github.com/open-artifacts-ai/open-artifacts/issues/370)) ([d615aa4](https://github.com/open-artifacts-ai/open-artifacts/commit/d615aa46b0f20f97aca0065ebd9aa86891405b7e))

## [0.18.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.17.1...v0.18.0) (2026-10-20)


### Features

* **inventory:** read-only install list for the prod probe ([#358](https://github.com/open-artifacts-ai/open-artifacts/issues/358)) ([3525f8a](https://github.com/open-artifacts-ai/open-artifacts/commit/3525f8a7e324ce5a372c41bfb3a935f3c5a9ad0c))
* **provision:** install ids, names and the Provisioner interface ([#357](https://github.com/open-artifacts-ai/open-artifacts/issues/357)) ([915b156](https://github.com/open-artifacts-ai/open-artifacts/commit/915b15688c4fb6fe923f9dcad06bc56f0db85fe1))
* **shared:** hosted M1 contract (auth providers, spaces, roles, directory, mocks) ([#359](https://github.com/open-artifacts-ai/open-artifacts/issues/359)) ([4271a12](https://github.com/open-artifacts-ai/open-artifacts/commit/4271a1258743d0669cdb677bc1a39c9732622390))
* **viewer:** in-artifact links to /a/&lt;id&gt; navigate the viewer ([#346](https://github.com/open-artifacts-ai/open-artifacts/issues/346)) ([ca6f940](https://github.com/open-artifacts-ai/open-artifacts/commit/ca6f9405f608d7a1104edcefe067691511969e80))


### Bug Fixes

* **server:** redact URLs, tokens and emails from logs ([#356](https://github.com/open-artifacts-ai/open-artifacts/issues/356)) ([cd4607a](https://github.com/open-artifacts-ai/open-artifacts/commit/cd4607a7912fc0eb689e5a9b3a3f7211e7125acf))
* **server:** separate anonymous data-socket pool, IPv6 /56 keys ([#347](https://github.com/open-artifacts-ai/open-artifacts/issues/347)) ([2948f63](https://github.com/open-artifacts-ai/open-artifacts/commit/2948f63bf70f57abc25c38517b8c1e91c83f318e))
* **smoke:** warm up staging and allow network-scale timeouts ([#360](https://github.com/open-artifacts-ai/open-artifacts/issues/360)) ([792915f](https://github.com/open-artifacts-ai/open-artifacts/commit/792915f28573cc866c5f4ead1d9b5529baf18ed0))

## [0.17.1](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.17.0...v0.17.1) (2026-10-20)


### Bug Fixes

* **smoke:** accept Cloudflare's weak /skill.md ETag; version-proof tool count test ([#353](https://github.com/open-artifacts-ai/open-artifacts/issues/353)) ([851b3ad](https://github.com/open-artifacts-ai/open-artifacts/commit/851b3ad998b834ded059921d2684cc6442808044))

## [0.17.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.16.0...v0.17.0) (2026-10-20)


### Features

* **runtime:** same-instance /a/ links navigate the viewer (oa:navigate) ([#345](https://github.com/open-artifacts-ai/open-artifacts/issues/345)) ([481a907](https://github.com/open-artifacts-ai/open-artifacts/commit/481a9072ab87caa3b9c69b53820ff4af6f156115))

## [0.16.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.15.0...v0.16.0) (2026-10-20)


### Features

* **runtime:** post oa:interacted once on first user interaction ([#341](https://github.com/open-artifacts-ai/open-artifacts/issues/341)) ([ab14aea](https://github.com/open-artifacts-ai/open-artifacts/commit/ab14aea8ca411b9f463e42b56ddb6f1cdc6b6b04))
* **server:** artifact events socket (live version updates) ([#343](https://github.com/open-artifacts-ai/open-artifacts/issues/343)) ([4d26d34](https://github.com/open-artifacts-ai/open-artifacts/commit/4d26d3433a4a884a4e53062b8556af1c35a54d1b))

## [0.15.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.14.0...v0.15.0) (2026-10-20)


### Features

* **demo:** real-time demo artifacts (poll, tic-tac-toe) and publish manifest ([#305](https://github.com/open-artifacts-ai/open-artifacts/issues/305)) ([c52a5bc](https://github.com/open-artifacts-ai/open-artifacts/commit/c52a5bcad7a1e36330838bbc11c345550b8cbf1b))

## [0.14.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.13.0...v0.14.0) (2026-10-20)


### Features

* **content:** new-tab links escape the sandbox; no top navigation ([#313](https://github.com/open-artifacts-ai/open-artifacts/issues/313)) ([872674c](https://github.com/open-artifacts-ai/open-artifacts/commit/872674c0235ede6b46be1b83f45f55334ba25252))
* **dashboard:** artifact popups escape the sandbox (fixes blank /a/&lt;id&gt; P0; needs user yes) ([#311](https://github.com/open-artifacts-ai/open-artifacts/issues/311)) ([cc2297d](https://github.com/open-artifacts-ai/open-artifacts/commit/cc2297d6d55c001758778edda5d1aa050174634d))

## [0.13.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.12.0...v0.13.0) (2026-10-20)


### Features

* **server:** anonymous id tokens carry issued-at and renew after 30 days ([#334](https://github.com/open-artifacts-ai/open-artifacts/issues/334)) ([df8d6c3](https://github.com/open-artifacts-ai/open-artifacts/commit/df8d6c350b301a612c7326a36f317b6af60e318a))
* **setup:** EMBED_ALLOW_SAME_SITE tunable ([#333](https://github.com/open-artifacts-ai/open-artifacts/issues/333)) ([e03b94a](https://github.com/open-artifacts-ai/open-artifacts/commit/e03b94a9e1cbc336fd89b55465844b2f30abba6b))


### Performance Improvements

* **server:** fewer D1 rows per publish ([#248](https://github.com/open-artifacts-ai/open-artifacts/issues/248)) ([#335](https://github.com/open-artifacts-ai/open-artifacts/issues/335)) ([24b477a](https://github.com/open-artifacts-ai/open-artifacts/commit/24b477a453c0f7b74168d5ccd4009a2287bf77fe))

## [0.12.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.11.0...v0.12.0) (2026-10-20)


### Features

* **server:** EMBED_ORIGINS lets /a/:id/full be framed by listed origins ([#295](https://github.com/open-artifacts-ai/open-artifacts/issues/295)) ([f3e472d](https://github.com/open-artifacts-ai/open-artifacts/commit/f3e472d5710f9d093ccdd323797070476cdaf70c))

## [0.11.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.10.0...v0.11.0) (2026-10-20)


### ⚠ BREAKING CHANGES

* **server:** get_artifact's downloadUrl is now a signed attachment URL that expires after 10 minutes (public artifacts used to get a non-expiring /p/ URL). Don't store it; call get_artifact again to get a fresh one.

### Features

* **server:** the content host never renders top-level; raw view removed ([#292](https://github.com/open-artifacts-ai/open-artifacts/issues/292)) ([#294](https://github.com/open-artifacts-ai/open-artifacts/issues/294)) ([771e16c](https://github.com/open-artifacts-ai/open-artifacts/commit/771e16cdc5a6dcae851f4132b9d4a92215faf90e))

## [0.10.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.9.0...v0.10.0) (2026-10-20)


### Features

* **dashboard:** framed /full runs anonymously (embed mode, gates [#295](https://github.com/open-artifacts-ai/open-artifacts/issues/295)) ([#321](https://github.com/open-artifacts-ai/open-artifacts/issues/321)) ([8c13e7d](https://github.com/open-artifacts-ai/open-artifacts/commit/8c13e7da8ed59218ef71739bf4334b7372e4791c))
* **viewer:** renavigation notice for live-data artifacts ([#326](https://github.com/open-artifacts-ai/open-artifacts/issues/326)) ([e4dfac3](https://github.com/open-artifacts-ai/open-artifacts/commit/e4dfac3821ef7db7cd9f2ba924c4a1bad2134999))

## [0.9.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.8.0...v0.9.0) (2026-10-20)


### Features

* **dashboard:** file-based token snippets in Settings → Agents ([#322](https://github.com/open-artifacts-ai/open-artifacts/issues/322)) ([d3ea8e6](https://github.com/open-artifacts-ai/open-artifacts/commit/d3ea8e6cfecf2b21ec3c26ad8587baaf05ba8864))
* **runtime:** per-load nonce on every bridge message ([#306](https://github.com/open-artifacts-ai/open-artifacts/issues/306)) ([944e934](https://github.com/open-artifacts-ai/open-artifacts/commit/944e934d0bac65482dff84dcfc80c7d4970fe7b7))
* **server:** per-instance overrides for live-data limits ([#303](https://github.com/open-artifacts-ai/open-artifacts/issues/303)) ([e48e179](https://github.com/open-artifacts-ai/open-artifacts/commit/e48e1796bfc05db270bd28df775ea21898ad4731))

## [0.8.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.7.0...v0.8.0) (2026-10-20)


### Features

* **demo-ops:** live activity feed for the demo dashboard ([#320](https://github.com/open-artifacts-ai/open-artifacts/issues/320)) ([6f419c7](https://github.com/open-artifacts-ai/open-artifacts/commit/6f419c717b7ce1d68d52e9744db42b74e4012005))

## [0.7.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.6.0...v0.7.0) (2026-10-20)


### Features

* **dashboard:** chromeless full-screen view at /a/&lt;id&gt;/full; remove Open raw ([#290](https://github.com/open-artifacts-ai/open-artifacts/issues/290)) ([#296](https://github.com/open-artifacts-ai/open-artifacts/issues/296)) ([b3d4bf3](https://github.com/open-artifacts-ai/open-artifacts/commit/b3d4bf3a60d75bf14882a5490bc1c904759f35b9))
* **dashboard:** Update available, sidebar chip and Version card (admins) ([#255](https://github.com/open-artifacts-ai/open-artifacts/issues/255)) ([8bca53b](https://github.com/open-artifacts-ai/open-artifacts/commit/8bca53bf6e1b749beee6a7fcc8d735226a8f7728))
* **demo-ops:** per-minute activity aggregator for the demo dashboard ([#310](https://github.com/open-artifacts-ai/open-artifacts/issues/310)) ([4be84ed](https://github.com/open-artifacts-ai/open-artifacts/commit/4be84ed203035d48ac1f2642cf50246f21baa054))
* **setup:** --var NAME=value keeps tunable Worker vars across deploys ([#315](https://github.com/open-artifacts-ai/open-artifacts/issues/315)) ([e657cd8](https://github.com/open-artifacts-ai/open-artifacts/commit/e657cd8b3811f86676243552708be0d0ea6f7137))


### Bug Fixes

* **setup:** --upgrade tolerates an Access API outage ([#317](https://github.com/open-artifacts-ai/open-artifacts/issues/317)) ([#318](https://github.com/open-artifacts-ai/open-artifacts/issues/318)) ([329fa7d](https://github.com/open-artifacts-ai/open-artifacts/commit/329fa7d701c9686bc42bdc62587c240e2a3de7ea))

## [0.6.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.5.0...v0.6.0) (2026-10-20)


### Features

* **dashboard:** Tailwind preflight on; drop the no-preflight workarounds ([#286](https://github.com/open-artifacts-ai/open-artifacts/issues/286)) ([48cc8f9](https://github.com/open-artifacts-ai/open-artifacts/commit/48cc8f91b025c883a44b7c2c255564b1c711136c))
* **server:** daily latest-release check for admins ([#250](https://github.com/open-artifacts-ai/open-artifacts/issues/250)) ([397c23b](https://github.com/open-artifacts-ai/open-artifacts/commit/397c23bef6015e66de4ffcffed55ad8b445e6a89))
* **server:** owner-only atomic data reset for an artifact ([#298](https://github.com/open-artifacts-ai/open-artifacts/issues/298)) ([7eef38a](https://github.com/open-artifacts-ai/open-artifacts/commit/7eef38ae6dd93cf4bf488edd62acf9fcbe1605f4))
* **server:** per-instance /skill.md generated from the MCP tool defs ([#251](https://github.com/open-artifacts-ai/open-artifacts/issues/251)) ([e9e0efb](https://github.com/open-artifacts-ai/open-artifacts/commit/e9e0efbc370fb98c65812ef34f463babec53b7c5))
* **setup:** skip a deploy when nothing changed ([#25](https://github.com/open-artifacts-ai/open-artifacts/issues/25)) ([#275](https://github.com/open-artifacts-ai/open-artifacts/issues/275)) ([2631b05](https://github.com/open-artifacts-ai/open-artifacts/commit/2631b05a35d9781d2f3eb792b8b77f3e9aaf33bd))


### Bug Fixes

* **runtime:** reject with no_shell outside the viewer ([#288](https://github.com/open-artifacts-ai/open-artifacts/issues/288)) ([#293](https://github.com/open-artifacts-ai/open-artifacts/issues/293)) ([16371a9](https://github.com/open-artifacts-ai/open-artifacts/commit/16371a991c3857da508f9f1a4a0592d7f3901ee0))

## [0.5.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.4.0...v0.5.0) (2026-10-20)


### Features

* **dashboard:** Usage on @oa/ui/shadcn (migration area 6) ([#243](https://github.com/open-artifacts-ai/open-artifacts/issues/243)) ([4d81432](https://github.com/open-artifacts-ai/open-artifacts/commit/4d814325db01a115974e40749c2fc302107c1c60))
* **dashboard:** Usage on Workers Paid ([#279](https://github.com/open-artifacts-ai/open-artifacts/issues/279)) ([#281](https://github.com/open-artifacts-ai/open-artifacts/issues/281)) ([0d53580](https://github.com/open-artifacts-ai/open-artifacts/commit/0d53580d7b9da3328ab8688ac33d13d98143aab8))
* **landing:** multiplayer artifacts section ([#280](https://github.com/open-artifacts-ai/open-artifacts/issues/280)) ([565587a](https://github.com/open-artifacts-ai/open-artifacts/commit/565587a64a3790ac82f2d12742bc4664f97a7ec5))
* **setup:** record the previous Worker version and add --rollback ([#266](https://github.com/open-artifacts-ai/open-artifacts/issues/266)) ([a22855b](https://github.com/open-artifacts-ai/open-artifacts/commit/a22855b01ac29b41efd3041aa768fc5acda0caae))


### Bug Fixes

* **dashboard:** Share sends one request per action; Modal drops its surface override ([#262](https://github.com/open-artifacts-ai/open-artifacts/issues/262)) ([f066c1d](https://github.com/open-artifacts-ai/open-artifacts/commit/f066c1dc0dafbbd7db9df259132e5cd4f36e4a57))
* **e2e:** anon write-limit step can't straddle the limiter window ([#285](https://github.com/open-artifacts-ai/open-artifacts/issues/285)) ([2e76ef6](https://github.com/open-artifacts-ai/open-artifacts/commit/2e76ef6fc03ba3a09d30e89ca89a0c6364a5d906))
* **server:** usage limits follow the plan ([#279](https://github.com/open-artifacts-ai/open-artifacts/issues/279)) ([#284](https://github.com/open-artifacts-ai/open-artifacts/issues/284)) ([fff37be](https://github.com/open-artifacts-ai/open-artifacts/commit/fff37be06a8367d5f4c278b96928ed6db6d00f7f))
* **setup:** --yes-paid silences free-plan warnings and turns thumbnails on ([#7](https://github.com/open-artifacts-ai/open-artifacts/issues/7), [#20](https://github.com/open-artifacts-ai/open-artifacts/issues/20)) ([#270](https://github.com/open-artifacts-ai/open-artifacts/issues/270)) ([83cee5a](https://github.com/open-artifacts-ai/open-artifacts/commit/83cee5a27c16dbb8d77bf904a483e93cbab09487))
* **ui:** 16px dialog titles to match the Studio type scale ([#234](https://github.com/open-artifacts-ai/open-artifacts/issues/234)) ([6cdf96d](https://github.com/open-artifacts-ai/open-artifacts/commit/6cdf96d3a48181d2340d61f4e35b04599a7414cd))

## [0.4.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.3.0...v0.4.0) (2026-10-20)


### Features

* **dashboard:** artifact detail chrome on @oa/ui/shadcn (migration area 4) ([#244](https://github.com/open-artifacts-ai/open-artifacts/issues/244)) ([23aef70](https://github.com/open-artifacts-ai/open-artifacts/commit/23aef70d601a63aecb9054e78777b0ec6add151d))
* **dashboard:** invite and share copy says when we email ([#167](https://github.com/open-artifacts-ai/open-artifacts/issues/167)) ([#237](https://github.com/open-artifacts-ai/open-artifacts/issues/237)) ([9034b56](https://github.com/open-artifacts-ai/open-artifacts/commit/9034b5648b42a15a7ad831f97fc11ff005cbbaf1))
* **dashboard:** Library and search on @oa/ui/shadcn (migration area 3) ([#242](https://github.com/open-artifacts-ai/open-artifacts/issues/242)) ([16cd99f](https://github.com/open-artifacts-ai/open-artifacts/commit/16cd99f30e95dd55256a5841396e2f18577a3673))
* **dashboard:** Settings on @oa/ui/shadcn (migration area 2) ([#241](https://github.com/open-artifacts-ai/open-artifacts/issues/241)) ([db87aa9](https://github.com/open-artifacts-ai/open-artifacts/commit/db87aa9e6529ffa0b5614e16857755c6e8beb907))
* **dashboard:** share and invite dialogs, CopyLink and Sonner toasts on @oa/ui/shadcn (migration area 5) ([#249](https://github.com/open-artifacts-ai/open-artifacts/issues/249)) ([8be9ce7](https://github.com/open-artifacts-ai/open-artifacts/commit/8be9ce7119025c32956604458fa2ac24ec2f4b54))
* **dashboard:** sidebar B (Inset) on the shadcn Sidebar ([#232](https://github.com/open-artifacts-ai/open-artifacts/issues/232)) ([6adf735](https://github.com/open-artifacts-ai/open-artifacts/commit/6adf7352a31689b2647be8ea8b39876d0312c1b5))
* **dashboard:** sign-in split brand panel ([#233](https://github.com/open-artifacts-ai/open-artifacts/issues/233)) ([55963f1](https://github.com/open-artifacts-ai/open-artifacts/commit/55963f178fcb1b3d127f30a3df9f1139de0fd7b3))
* **landing:** live desk hero and tighter page rhythm ([#228](https://github.com/open-artifacts-ai/open-artifacts/issues/228)) ([487f7c9](https://github.com/open-artifacts-ai/open-artifacts/commit/487f7c98a18be1cf8357f4583d4aeb755f6ff09d))
* **server:** /healthz reports the instance version ([#247](https://github.com/open-artifacts-ai/open-artifacts/issues/247)) ([5383b71](https://github.com/open-artifacts-ai/open-artifacts/commit/5383b7152a5267ab788b26d19d33dded4b4c511c))
* **shared:** Me.instance.emailEnabled ([#167](https://github.com/open-artifacts-ai/open-artifacts/issues/167)) ([#236](https://github.com/open-artifacts-ai/open-artifacts/issues/236)) ([b66f858](https://github.com/open-artifacts-ai/open-artifacts/commit/b66f858a38495c8a5bc8a4a3d87d26a2e3cc80b3))
* **ui:** export toast() and set Studio Toaster defaults ([#245](https://github.com/open-artifacts-ai/open-artifacts/issues/245)) ([97c72c5](https://github.com/open-artifacts-ai/open-artifacts/commit/97c72c5844cb98b3c19b19520313677d640a4e9f))
* **ui:** shadcn Popover ([#254](https://github.com/open-artifacts-ai/open-artifacts/issues/254)) ([5baf9b9](https://github.com/open-artifacts-ai/open-artifacts/commit/5baf9b929adc6219f3ae5c5628ce7b6a51dd0851))


### Bug Fixes

* **dashboard:** invite form sends once on a fast double Enter ([#252](https://github.com/open-artifacts-ai/open-artifacts/issues/252)) ([5913106](https://github.com/open-artifacts-ai/open-artifacts/commit/59131065be813ee266b87a405edb43391e4bc226))
* **dashboard:** one request per submit for Profile, display name, Details and restore ([#257](https://github.com/open-artifacts-ai/open-artifacts/issues/257)) ([b9b6a5e](https://github.com/open-artifacts-ai/open-artifacts/commit/b9b6a5e5e1045cdd1e38ede97dd5448fa104b7a6))
* **mcp:** 401s explain a missing or empty bearer token ([#261](https://github.com/open-artifacts-ai/open-artifacts/issues/261)) ([0eeb439](https://github.com/open-artifacts-ai/open-artifacts/commit/0eeb4399374ba08b6d73c929b058473b4a48693c))
* **mcp:** instructions state the Free data-doc limit (256 KB), not 1 MB ([#246](https://github.com/open-artifacts-ai/open-artifacts/issues/246)) ([b7fdf1b](https://github.com/open-artifacts-ai/open-artifacts/commit/b7fdf1b1b6836e6174facd46ef637e52d52ecfee))
* **ui:** dialogs and sheets on the popover surface ([#256](https://github.com/open-artifacts-ai/open-artifacts/issues/256)) ([da9e697](https://github.com/open-artifacts-ai/open-artifacts/commit/da9e6979ee0bc5c434bbf923af5bf70683d7fd0d))


### Performance Improvements

* **server:** no thumbnail bookkeeping in alarms when the gate is off; alarm CPU guard and benches ([#223](https://github.com/open-artifacts-ai/open-artifacts/issues/223)) ([c0ce35b](https://github.com/open-artifacts-ai/open-artifacts/commit/c0ce35b00bb138f83cccf968d836d8ce1930c1e5))

## [0.3.0](https://github.com/open-artifacts-ai/open-artifacts/compare/v0.2.1...v0.3.0) (2026-10-19)


### ⚠ BREAKING CHANGES

* on Workers Free (PLAN unset or "free"), data docs and storage values drop from 1 MB to 256 KB, and /mcp request bodies over 320 KB are refused before parsing (HTTP 413, JSON-RPC error -32000). Paid (PLAN=paid) keeps 1 MB docs, with a 1 MB + 64 KB /mcp body cap. Publish large files through create_upload.

### Features

* CPU-limit and KV-write usage metrics, MCP CPU nudge ([#159](https://github.com/open-artifacts-ai/open-artifacts/issues/159)) ([065b2e0](https://github.com/open-artifacts-ai/open-artifacts/commit/065b2e067823671322896aaf72eb739366fd71f0))
* **dashboard:** CPU-limit (1102) banner, Usage CPU card and viewer notice ([#198](https://github.com/open-artifacts-ai/open-artifacts/issues/198)) ([3ca56e1](https://github.com/open-artifacts-ai/open-artifacts/commit/3ca56e1967e8870772096b51a1dab6e274ac8f70))
* **dashboard:** display-name dialog and Settings → Profile ([#215](https://github.com/open-artifacts-ai/open-artifacts/issues/215)) ([#219](https://github.com/open-artifacts-ai/open-artifacts/issues/219)) ([a8355e1](https://github.com/open-artifacts-ai/open-artifacts/commit/a8355e1507518f42c3545513d13368c3ce20c178))
* **dashboard:** remove human Upload version; agents publish new versions ([#194](https://github.com/open-artifacts-ai/open-artifacts/issues/194)) ([0c0545f](https://github.com/open-artifacts-ai/open-artifacts/commit/0c0545fd3923a53da121df3a3d70d81fdd5c77f2))
* **dashboard:** sign-in shows the instance name for visitors not signed in ([#162](https://github.com/open-artifacts-ai/open-artifacts/issues/162)) ([c2a6145](https://github.com/open-artifacts-ai/open-artifacts/commit/c2a6145575b40cecd68b476a45606ad97824d848))
* **dashboard:** versioned thumbnail uploads (?v=, 409 = up to date) ([#179](https://github.com/open-artifacts-ai/open-artifacts/issues/179)) ([e649d85](https://github.com/open-artifacts-ai/open-artifacts/commit/e649d8510a6521c8d8f4fbb6742a94d18dd7a482))
* **landing:** which Cloudflare plan (D7) ([#174](https://github.com/open-artifacts-ai/open-artifacts/issues/174)) ([4205992](https://github.com/open-artifacts-ai/open-artifacts/commit/4205992a99ac335d5722bd9f509f933717ea36d9))
* plan-aware data-doc limits and /mcp body cap ([#212](https://github.com/open-artifacts-ai/open-artifacts/issues/212)) ([3bd9bec](https://github.com/open-artifacts-ai/open-artifacts/commit/3bd9bec43c7e470a7b715f4ebf3eb67e8debaf47))
* **server:** invite and share emails via Cloudflare Email Service ([#167](https://github.com/open-artifacts-ai/open-artifacts/issues/167)) ([#177](https://github.com/open-artifacts-ai/open-artifacts/issues/177)) ([f2b16fe](https://github.com/open-artifacts-ai/open-artifacts/commit/f2b16fe90576c0186277fbf6d36f134f797a29d9))
* **server:** log email messageId and failure reason without PII ([#209](https://github.com/open-artifacts-ai/open-artifacts/issues/209)) ([1a4ee57](https://github.com/open-artifacts-ai/open-artifacts/commit/1a4ee57224e50aa76206f81c70ab760e115d7bb8))
* **server:** server-side thumbnails via Browser Run ([#157](https://github.com/open-artifacts-ai/open-artifacts/issues/157)) ([b11367d](https://github.com/open-artifacts-ai/open-artifacts/commit/b11367d6ca9cd2ab1f1b668c95b91ba96225428f))
* **setup:** --token-links and --token-page from one token table ([#207](https://github.com/open-artifacts-ai/open-artifacts/issues/207)) ([953f7f6](https://github.com/open-artifacts-ai/open-artifacts/commit/953f7f6bffcf64fac139e485d63495a18e03aab3))
* **setup:** render the PLAN var from the Cloudflare plan, with --plan override and a downgrade guard ([#216](https://github.com/open-artifacts-ai/open-artifacts/issues/216)) ([b4b1652](https://github.com/open-artifacts-ai/open-artifacts/commit/b4b1652106b37a94a1407eeaf6ef7b80507a6ea4))
* **setup:** Workers plan detection, team/solo, email sending domain step and send_email binding ([#180](https://github.com/open-artifacts-ai/open-artifacts/issues/180)) ([ea1af3b](https://github.com/open-artifacts-ai/open-artifacts/commit/ea1af3b2c462c873c87c2ef5c0309d9a5118b9b4))
* **ui:** Banner icon, optional title, compact and dismiss ([06d8754](https://github.com/open-artifacts-ai/open-artifacts/commit/06d875433d74d00b0ad65418b8b1c5358a826a35))
* **ui:** no-preflight shadcn entry for incremental migration ([#225](https://github.com/open-artifacts-ai/open-artifacts/issues/225)) ([4a5c670](https://github.com/open-artifacts-ai/open-artifacts/commit/4a5c670fd1831e603462fde6c1ea3e25f5b72be4))
* **ui:** shadcn core components (Button, Input, Label, Card, Badge, Avatar, Tooltip, Skeleton, Separator) ([#201](https://github.com/open-artifacts-ai/open-artifacts/issues/201)) ([9bd8dfd](https://github.com/open-artifacts-ai/open-artifacts/commit/9bd8dfd9a088543ca5e0044ae7de92c09fb1e072))
* **ui:** shadcn overlays (Select, Dialog, AlertDialog, DropdownMenu, Tabs, ToggleGroup, Table, ScrollArea, Sonner) ([#205](https://github.com/open-artifacts-ai/open-artifacts/issues/205)) ([ad11c7c](https://github.com/open-artifacts-ai/open-artifacts/commit/ad11c7cbec4bf70f95108cd6c9e3fc6e1f664ecc))
* **ui:** shadcn Sidebar (flush, off-canvas) with Framed Artifact brand ([#226](https://github.com/open-artifacts-ai/open-artifacts/issues/226)) ([407e531](https://github.com/open-artifacts-ai/open-artifacts/commit/407e53110de7bff4c84cd467106107ffaee91b74))
* **ui:** shadcn/ui foundation (Tailwind v4, theme mapped to Studio tokens) ([#190](https://github.com/open-artifacts-ai/open-artifacts/issues/190)) ([85bc0b3](https://github.com/open-artifacts-ai/open-artifacts/commit/85bc0b3f70903536842847c47e7a8ff967ba5f63))
* user display name ([#215](https://github.com/open-artifacts-ai/open-artifacts/issues/215)) ([#218](https://github.com/open-artifacts-ai/open-artifacts/issues/218)) ([22d9ff7](https://github.com/open-artifacts-ai/open-artifacts/commit/22d9ff719772b062b57bc28ec82900f957eefbf5))


### Bug Fixes

* **dashboard:** display-name follow-ups from Design's review of [#219](https://github.com/open-artifacts-ai/open-artifacts/issues/219) ([#229](https://github.com/open-artifacts-ai/open-artifacts/issues/229)) ([293e8e2](https://github.com/open-artifacts-ai/open-artifacts/commit/293e8e21993504b8801c1e3ff258ac4c62d97bfd))
* **dashboard:** favicon, apple-touch-icon and theme-color links ([#195](https://github.com/open-artifacts-ai/open-artifacts/issues/195)) ([e38e9a4](https://github.com/open-artifacts-ai/open-artifacts/commit/e38e9a4fac1150a28261f4affa5dee6ffb6666ec))
* **dashboard:** invites and shares show the link to send, not an email promise ([#170](https://github.com/open-artifacts-ai/open-artifacts/issues/170)) ([be8338e](https://github.com/open-artifacts-ai/open-artifacts/commit/be8338e6490cffa339492532bd53a4eae4994a93))
* **dashboard:** M2 review — snippet a11y, instance name in titles, demotion refresh ([#161](https://github.com/open-artifacts-ai/open-artifacts/issues/161)) ([fdc376b](https://github.com/open-artifacts-ai/open-artifacts/commit/fdc376bc7b695a2ce343b1161772eb6afea43ca4))
* **dashboard:** Settings → Agents spacing on shadcn primitives (P1) ([#222](https://github.com/open-artifacts-ai/open-artifacts/issues/222)) ([d2f8cb2](https://github.com/open-artifacts-ai/open-artifacts/commit/d2f8cb2ce50fa636017c92797b75791c65f7717b))
* **dashboard:** visibility confirmation layout in Share ([#193](https://github.com/open-artifacts-ai/open-artifacts/issues/193)) ([ac322a4](https://github.com/open-artifacts-ai/open-artifacts/commit/ac322a4ab0487a42e4acf709ea2b078c75b310fd))
* **e2e:** make the agent journey deterministic under parallel workers ([#185](https://github.com/open-artifacts-ai/open-artifacts/issues/185)) ([#200](https://github.com/open-artifacts-ai/open-artifacts/issues/200)) ([62ee196](https://github.com/open-artifacts-ai/open-artifacts/commit/62ee19635751aa74cfefe2abd96a8850f3927af2))
* **e2e:** usage smoke skips when analytics is unconfigured (staging red) ([#188](https://github.com/open-artifacts-ai/open-artifacts/issues/188)) ([d5e535b](https://github.com/open-artifacts-ai/open-artifacts/commit/d5e535b18acde04f45dfe42259b128f3144915cd))
* **email:** copy and deliverability fixes ([#213](https://github.com/open-artifacts-ai/open-artifacts/issues/213)) ([#214](https://github.com/open-artifacts-ai/open-artifacts/issues/214)) ([c6e92a9](https://github.com/open-artifacts-ai/open-artifacts/commit/c6e92a9b7003da21e6da3164c13cac984884ca74))
* **server:** favicon links on server-rendered pages ([#197](https://github.com/open-artifacts-ai/open-artifacts/issues/197)) ([d665d83](https://github.com/open-artifacts-ai/open-artifacts/commit/d665d831a29866a2625127083fb18619e2cf3cef))
* **smoke:** staging /healthz reports plan paid since [#212](https://github.com/open-artifacts-ai/open-artifacts/issues/212) ([#220](https://github.com/open-artifacts-ai/open-artifacts/issues/220)) ([cbead9f](https://github.com/open-artifacts-ai/open-artifacts/commit/cbead9f6e73a0bdc312a7f0fabf8dd7450ff3205))
* **ui:** border-box form controls ([7a097be](https://github.com/open-artifacts-ai/open-artifacts/commit/7a097be81ee7d9a02ab0b069c208bd7f7d6bd38c))
* **ui:** color-only transitions on Button and Tabs, left-aligned dialog header ([#227](https://github.com/open-artifacts-ai/open-artifacts/issues/227)) ([3c3cad1](https://github.com/open-artifacts-ai/open-artifacts/commit/3c3cad1bdab44463efd377ce8254f5aad10fff01))


### Performance Improvements

* **server:** raw CDP client for thumbnail captures (drop puppeteer) ([#192](https://github.com/open-artifacts-ai/open-artifacts/issues/192)) ([d6b4680](https://github.com/open-artifacts-ai/open-artifacts/commit/d6b4680b008114d92b9b878d4eb976c6c1350d39))

## [0.2.1](https://github.com/leourbina/open-artifacts/compare/v0.2.0...v0.2.1) (2026-10-19)


### Bug Fixes

* **setup:** selftest follows the markdown render shell to its entry file ([#165](https://github.com/leourbina/open-artifacts/issues/165)) ([b28e20e](https://github.com/leourbina/open-artifacts/commit/b28e20e9f37bda0e17dfda5247ce6924d2cf8b04))

## [0.2.0](https://github.com/leourbina/open-artifacts/compare/v0.1.0...v0.2.0) (2026-10-19)


### ⚠ BREAKING CHANGES

* **server:** 256 KB inline limit, async search indexing (C3) ([#126](https://github.com/leourbina/open-artifacts/issues/126))

### Features

* **dashboard:** card and row hover, focus and pressed states ([#136](https://github.com/leourbina/open-artifacts/issues/136)) ([c30f838](https://github.com/leourbina/open-artifacts/commit/c30f838971e49e41bdf170db328df6f7ad832b05))
* **dashboard:** send db.resync on every subscription open (C4) ([#128](https://github.com/leourbina/open-artifacts/issues/128)) ([686132e](https://github.com/leourbina/open-artifacts/commit/686132e63dab757d94b5122e9f4f643a1dddfb53))
* **dashboard:** settings agents — MCP snippets, OAuth clients, tokens (FE9) ([#116](https://github.com/leourbina/open-artifacts/issues/116)) ([6a81ed5](https://github.com/leourbina/open-artifacts/commit/6a81ed56768ef33cb0439dde71aadffcab858eba))
* **dashboard:** settings instance and usage (FE10) ([#121](https://github.com/leourbina/open-artifacts/issues/121)) ([5d1662b](https://github.com/leourbina/open-artifacts/commit/5d1662b1a2e4975fde6b086cb84195d4bfde0cc8))
* **dashboard:** thumbnails and PDF text pipeline (FE11) ([#124](https://github.com/leourbina/open-artifacts/issues/124)) ([cfe8b03](https://github.com/leourbina/open-artifacts/commit/cfe8b0380913ecd04f33cdcbd403ae73100983b9))
* **landing:** product-led layout with agent-first copy (D7) ([49df286](https://github.com/leourbina/open-artifacts/commit/49df2865b7aaad6afba7b21c418a7129e1b25712))
* **runtime:** db.resync event after reconnect (C4) ([#125](https://github.com/leourbina/open-artifacts/issues/125)) ([03c7aa8](https://github.com/leourbina/open-artifacts/commit/03c7aa812a9f748c9658e8bffaa1a3888690cb70))
* **server:** 256 KB inline limit, async search indexing (C3) ([#126](https://github.com/leourbina/open-artifacts/issues/126)) ([4a9ae0f](https://github.com/leourbina/open-artifacts/commit/4a9ae0f0633da9e319e2bd528e5b9063d98e88cd))
* **server:** expose instance name to the SPA shell via meta tag ([#158](https://github.com/leourbina/open-artifacts/issues/158)) ([7079868](https://github.com/leourbina/open-artifacts/commit/7079868c8abaa5e061789ca9d8654db9d979aaaf))
* **server:** MCP server, tools and PAT routing (B14-1) ([#95](https://github.com/leourbina/open-artifacts/issues/95)) ([75a8263](https://github.com/leourbina/open-artifacts/commit/75a8263484192bca5cb443aad525163065893cdb))
* **server:** OAuth provider, consent page and oauth-clients routes (B14-2) ([#97](https://github.com/leourbina/open-artifacts/issues/97)) ([970d5e2](https://github.com/leourbina/open-artifacts/commit/970d5e2787a9c9041de13e876b54e5bc6da33a29))
* **setup:** --ci mode never prints the owner token and revokes it after selftest (B16-7) ([#137](https://github.com/leourbina/open-artifacts/issues/137)) ([8e6ae6f](https://github.com/leourbina/open-artifacts/commit/8e6ae6f0e18854e082adc721655f8e8f99ad9fe4))
* **setup:** optional BROWSER binding (Browser Run), default on; --no-browser opt-out ([#154](https://github.com/leourbina/open-artifacts/issues/154)) ([1b5b6cd](https://github.com/leourbina/open-artifacts/commit/1b5b6cdd247d3d70fa85395054ac801c989e73be))
* **setup:** rebuild state from Cloudflare by name; --check read-only mode (B16-5) ([#111](https://github.com/leourbina/open-artifacts/issues/111)) ([7d233f1](https://github.com/leourbina/open-artifacts/commit/7d233f1551a8e71c895990ffd72eaaed9b5e2262))


### Bug Fixes

* **ci:** checkout before release-pr-dispatch; guard scripts/ use without checkout ([#142](https://github.com/leourbina/open-artifacts/issues/142)) ([9409524](https://github.com/leourbina/open-artifacts/commit/9409524860050ec207284da45405f9d8acb2cc52))
* **dashboard:** agent snippets never embed the token ([#148](https://github.com/leourbina/open-artifacts/issues/148)) ([#150](https://github.com/leourbina/open-artifacts/issues/150)) ([2ea0fd1](https://github.com/leourbina/open-artifacts/commit/2ea0fd163965183fa18cfdb308ac6564f0158f2a))
* **dashboard:** deterministic usage date and e2e abort handling ([#147](https://github.com/leourbina/open-artifacts/issues/147)) ([5a2f387](https://github.com/leourbina/open-artifacts/commit/5a2f38766f7b697d85643c957c2fdad8e56a611b))
* **dashboard:** whole library card and row open the artifact ([#133](https://github.com/leourbina/open-artifacts/issues/133)) ([2e3469e](https://github.com/leourbina/open-artifacts/commit/2e3469eeaa044743a52820826f3ac8c2709a9a0d))
* **server:** key /oauth/token rate limit on the authenticated client ([#149](https://github.com/leourbina/open-artifacts/issues/149)) ([#151](https://github.com/leourbina/open-artifacts/issues/151)) ([c54c7ce](https://github.com/leourbina/open-artifacts/commit/c54c7ce802e181b9a151f998b6d69cbec4074748))
* **server:** M2 review fixes (sockets, privacy, quotas, MCP parity) ([#119](https://github.com/leourbina/open-artifacts/issues/119)) ([4161daa](https://github.com/leourbina/open-artifacts/commit/4161daa8f2efeec7d1017294900ea3d7b3d2cc4d))
* **setup:** agent-config follow-ups (OpenCode oauth:false, unset token, guidance) ([#105](https://github.com/leourbina/open-artifacts/issues/105)) ([0615472](https://github.com/leourbina/open-artifacts/commit/061547274ce92d7870eb4d6b6b027ee820df54a9))
* **setup:** agent-config never embeds the token ([#98](https://github.com/leourbina/open-artifacts/issues/98)) ([43dba90](https://github.com/leourbina/open-artifacts/commit/43dba905edd628415b6fc2c3dd36acf965d5fb3b))
* **setup:** owner token revokes prior setup PATs, respects the cap, demotes a replaced owner (B16-6) ([#117](https://github.com/leourbina/open-artifacts/issues/117)) ([855f646](https://github.com/leourbina/open-artifacts/commit/855f6467179bfd3b397e521ca05235dc560edb8e))
* **ui,render:** control border contrast and render error style ([19223b2](https://github.com/leourbina/open-artifacts/commit/19223b2c969bb78987fcafa55a704ecd4b0ada1f))


### Performance Improvements

* **server:** 10 s index debounce, 64 KB index input ([#145](https://github.com/leourbina/open-artifacts/issues/145)) ([09764d0](https://github.com/leourbina/open-artifacts/commit/09764d09c1b82dc5ac1952f5b5a1e09eb7908b6f))
* **server:** cut per-request CPU on publish and list ([#120](https://github.com/leourbina/open-artifacts/issues/120)) ([bfbea08](https://github.com/leourbina/open-artifacts/commit/bfbea08eb948d8239c61d65ec1140502d8b56cb5))
* **server:** eager isolate init, 128 KB index cap ([#134](https://github.com/leourbina/open-artifacts/issues/134)) ([debd746](https://github.com/leourbina/open-artifacts/commit/debd746969a2658a07224016d5fa268e783b2a62))
* **server:** leaner request path and publish allocations ([#141](https://github.com/leourbina/open-artifacts/issues/141)) ([c5dda24](https://github.com/leourbina/open-artifacts/commit/c5dda24ece98a83a40e10518eddeb84c6e0b1156))

## 0.1.0 (2026-10-18)


### ⚠ BREAKING CHANGES

* **server:** __Host- session cookie ([#82](https://github.com/leourbina/open-artifacts/issues/82))
* **shared:** nullable UserRef.email, paged versions, StorageSetBody (contract C1) ([#42](https://github.com/leourbina/open-artifacts/issues/42))

### Features

* **brand:** logo and favicons (D6) ([dcefb8c](https://github.com/leourbina/open-artifacts/commit/dcefb8cdc491e3329c3c63da21392cbc6e7afd06))
* **dashboard:** app scaffold, API client, routing (FE1) ([#26](https://github.com/leourbina/open-artifacts/issues/26)) ([3f5e2eb](https://github.com/leourbina/open-artifacts/commit/3f5e2eb19af6acff01d1870ffc53871f82eccb07))
* **dashboard:** auth state, layout, edge pages, quota banner (FE2) ([#37](https://github.com/leourbina/open-artifacts/issues/37)) ([b77dec6](https://github.com/leourbina/open-artifacts/commit/b77dec6e5482ed580d6cb22c591eccf589c095a4))
* **dashboard:** drag-and-drop upload (FE7) ([#87](https://github.com/leourbina/open-artifacts/issues/87)) ([72f6c6d](https://github.com/leourbina/open-artifacts/commit/72f6c6da914a2d421dad901c3c8c70bff034270d))
* **dashboard:** library list, grid, scopes, filters (FE3-2) ([#53](https://github.com/leourbina/open-artifacts/issues/53)) ([85a3a13](https://github.com/leourbina/open-artifacts/commit/85a3a13efc9641a6591322471cd4180cdbd2e086))
* **dashboard:** postMessage bridge and signed content URLs (FE4-1) ([#56](https://github.com/leourbina/open-artifacts/issues/56)) ([6777048](https://github.com/leourbina/open-artifacts/commit/677704840c12264a03563eeb95efa8d19d5bbf80))
* **dashboard:** search box, search results, snippet highlighting (FE3-1) ([#52](https://github.com/leourbina/open-artifacts/issues/52)) ([6402041](https://github.com/leourbina/open-artifacts/commit/6402041206b3491d28fd620ce691167bba78840d))
* **dashboard:** settings members (FE8) ([#88](https://github.com/leourbina/open-artifacts/issues/88)) ([920cecc](https://github.com/leourbina/open-artifacts/commit/920cecc9668ddc7b01a113c62f49e4f9a70a59d6))
* **dashboard:** share panel and details (FE6) ([#86](https://github.com/leourbina/open-artifacts/issues/86)) ([74715d9](https://github.com/leourbina/open-artifacts/commit/74715d97a7f8057df23a47c1ece2a73832f59495))
* **dashboard:** versions panel and diff (FE5) ([#65](https://github.com/leourbina/open-artifacts/issues/65)) ([d8f40e6](https://github.com/leourbina/open-artifacts/commit/d8f40e6a2375baaa3a2dd2a0e6f9947fd0003f53))
* **dashboard:** viewer shell and title bar (FE4-2) ([#61](https://github.com/leourbina/open-artifacts/issues/61)) ([4a7ed61](https://github.com/leourbina/open-artifacts/commit/4a7ed612de82b2499a598f8ef6bb7532433f9fcb))
* **landing:** D6 logo (D7) ([5417ad2](https://github.com/leourbina/open-artifacts/commit/5417ad2fcc4c740001b96aa768619bff971e05c0))
* **landing:** docs and llms.txt (D7) ([20f945c](https://github.com/leourbina/open-artifacts/commit/20f945c89ed4736499c337bb654f2a30ba4d9d68))
* **landing:** site and landing page (D7) ([f012c71](https://github.com/leourbina/open-artifacts/commit/f012c71c193bc577eda6dd473b847278a2300c04))
* **render:** markdown, code and pdf renderers (B11) ([#69](https://github.com/leourbina/open-artifacts/issues/69)) ([63283d9](https://github.com/leourbina/open-artifacts/commit/63283d9a5c25302043731954448e43e0e34bb9b5))
* **render:** reading themes (D5) ([ba34a2a](https://github.com/leourbina/open-artifacts/commit/ba34a2a07a1f5119aef12e8519ce5e0925154525))
* **runtime:** data routes, subscribe, anon rate limit, SDK (B13) ([#89](https://github.com/leourbina/open-artifacts/issues/89)) ([ecd9be2](https://github.com/leourbina/open-artifacts/commit/ecd9be230b32fa17071aba2e948ec78283a10480))
* **server:** Access OIDC login, dev login, users (B4) ([#31](https://github.com/leourbina/open-artifacts/issues/31)) ([93fb1e9](https://github.com/leourbina/open-artifacts/commit/93fb1e91bee9f2cf41d7842175ddb577fa419d3f))
* **server:** artifact read, list, versions, restore, purge (B7) ([#45](https://github.com/leourbina/open-artifacts/issues/45)) ([2a1b71b](https://github.com/leourbina/open-artifacts/commit/2a1b71bffece9341e994b74b3167dffa6e9fca51))
* **server:** artifact sharing (B9) ([#55](https://github.com/leourbina/open-artifacts/issues/55)) ([27d901e](https://github.com/leourbina/open-artifacts/commit/27d901e7b87bcb88a6d8cb377f52b58c136392e6))
* **server:** ArtifactRuntime durable object (B12) ([#80](https://github.com/leourbina/open-artifacts/issues/80)) ([f10228b](https://github.com/leourbina/open-artifacts/commit/f10228b2310440e25410f8096cb00c3be5ef536d))
* **server:** authorization, members, settings, CSRF (B5) ([#34](https://github.com/leourbina/open-artifacts/issues/34)) ([6ecb939](https://github.com/leourbina/open-artifacts/commit/6ecb93915d324d2273ecdd5684e5921b3be5ba06))
* **server:** content host, signed paths, sandbox, runtime injection (B10) ([#64](https://github.com/leourbina/open-artifacts/issues/64)) ([78bcc7c](https://github.com/leourbina/open-artifacts/commit/78bcc7cd7d5aaa707f87452493eb52e33d98e7ce))
* **server:** crypto utils, sessions, PATs (B3) ([#29](https://github.com/leourbina/open-artifacts/issues/29)) ([47877de](https://github.com/leourbina/open-artifacts/commit/47877de4039c45d2985983384003e0dc3923f138))
* **server:** D1 schema and migrations (B2) ([#27](https://github.com/leourbina/open-artifacts/issues/27)) ([8ec76f6](https://github.com/leourbina/open-artifacts/commit/8ec76f6081ad543521c128e39fe5fafb566c1746))
* **server:** full-text search and text extraction (B8) ([#57](https://github.com/leourbina/open-artifacts/issues/57)) ([7e2d00a](https://github.com/leourbina/open-artifacts/commit/7e2d00a44add21845c1fc02b5739531688639d1d))
* **server:** race-safe publish, manifests, uploads (B6) ([#36](https://github.com/leourbina/open-artifacts/issues/36)) ([b7f68ea](https://github.com/leourbina/open-artifacts/commit/b7f68ea2f553d0b9fc324b3d5ab2e340bb4b9cac))
* **server:** tokens, OG shell, thumbnails, usage (B15) ([#93](https://github.com/leourbina/open-artifacts/issues/93)) ([3959b27](https://github.com/leourbina/open-artifacts/commit/3959b27ee1520852e925ef2512c9705e8e4091cf))
* **server:** worker skeleton, env, errors, security headers (B1) ([#25](https://github.com/leourbina/open-artifacts/issues/25)) ([8f8fa5f](https://github.com/leourbina/open-artifacts/commit/8f8fa5fa8a69435d672c71893053073d6ff302c9))
* **setup:** access and secrets steps (B16-2) ([#59](https://github.com/leourbina/open-artifacts/issues/59)) ([cf8f7e3](https://github.com/leourbina/open-artifacts/commit/cf8f7e3977abd65f985b788b7c7f810e78933150))
* **setup:** CLI framework, state, Cloudflare client (B16-1a) ([#50](https://github.com/leourbina/open-artifacts/issues/50)) ([24e25f9](https://github.com/leourbina/open-artifacts/commit/24e25f91ba8dba06109215a56863c032b7c201f3))
* **setup:** deploy, owner token, selftest, agent config (B16-3) ([#67](https://github.com/leourbina/open-artifacts/issues/67)) ([401a7e2](https://github.com/leourbina/open-artifacts/commit/401a7e2f3d8068455936282b6e86a69ebb19f5e6))
* **setup:** non-interactive --json, welcomeUrl, Access re-run skip (B16 follow-up) ([#70](https://github.com/leourbina/open-artifacts/issues/70)) ([47cb8d1](https://github.com/leourbina/open-artifacts/commit/47cb8d10fdd5b98f4684eba7eb0b8698f2ce47f9))
* **setup:** prereqs and resources steps (B16-1b) ([#51](https://github.com/leourbina/open-artifacts/issues/51)) ([7acb22e](https://github.com/leourbina/open-artifacts/commit/7acb22e9ed345f5ad25fbe89d37a1d6371fba3af))
* **shared:** API contract, ids, paths, protocol (F2) ([#7](https://github.com/leourbina/open-artifacts/issues/7)) ([2755a13](https://github.com/leourbina/open-artifacts/commit/2755a1367e804902daa93eb50082312b4556ee38))
* **shared:** nullable UserRef.email, paged versions, StorageSetBody (contract C1) ([#42](https://github.com/leourbina/open-artifacts/issues/42)) ([f903193](https://github.com/leourbina/open-artifacts/commit/f9031933d30e9d1bc0325d8eb325b2fd0243b901))
* **ui:** banner, empty state, app shell, nav item (D3) ([8f24a90](https://github.com/leourbina/open-artifacts/commit/8f24a9042fec35bcd8019df5f59672437f3e5ae3))
* **ui:** core components, part 1 (D3) ([1a32cdd](https://github.com/leourbina/open-artifacts/commit/1a32cdd1704426dc2de4bb31401a7129b5be0f98))
* **ui:** core components, part 1b (D3) ([ebcf425](https://github.com/leourbina/open-artifacts/commit/ebcf425efdf36c90c69da1b97af44b9d59f6fc5f))
* **ui:** design tokens (D2) ([c653074](https://github.com/leourbina/open-artifacts/commit/c653074c4093fffed0a0fb06adb2a6282a97c33d))
* **ui:** nullable email in Avatar and displayName ([9c724fd](https://github.com/leourbina/open-artifacts/commit/9c724fdaacd3b2cd22ff909fec51957434547755))
* **ui:** overlays — dialog, menu, tabs, toast (D3) ([83d05b8](https://github.com/leourbina/open-artifacts/commit/83d05b89f3f0db2fe88fbaa500cafe0dbf8dc77f))
* **ui:** toast action ([60d2a4b](https://github.com/leourbina/open-artifacts/commit/60d2a4bb72c341afe38192cc1f75e48639978114))


### Bug Fixes

* **dashboard:** M1 review — session expiry, signed URL freshness, a11y ([#85](https://github.com/leourbina/open-artifacts/issues/85)) ([3146350](https://github.com/leourbina/open-artifacts/commit/3146350d5c8de24a7e7e8f03ec3f317e737516d8))
* harden workspace scaffold checks and tool versions ([f79a5fe](https://github.com/leourbina/open-artifacts/commit/f79a5fe5a32dabe03f4498a0da88c987d6be9ee0))
* **landing:** fail typecheck when astro check silently skips ([038eafa](https://github.com/leourbina/open-artifacts/commit/038eafadd9855365cb2d7120c6f9e253c19a9e75))
* **landing:** single-quote MCP auth header in docs ([a226e51](https://github.com/leourbina/open-artifacts/commit/a226e51b30c7f4a6f8961136f93cbb3c079661d8))
* **server:** __Host- session cookie ([#82](https://github.com/leourbina/open-artifacts/issues/82)) ([bf06eaa](https://github.com/leourbina/open-artifacts/commit/bf06eaaaa39ed3e7428054d42b7e1be6e8b91e64))
* **server:** build @oa/shared before staging smoke ([#39](https://github.com/leourbina/open-artifacts/issues/39)) ([1d76593](https://github.com/leourbina/open-artifacts/commit/1d76593b11a29b6f0674728789f658837ece9840))
* **server:** per-version format, bounded version lists, path edge cases (M1) ([#74](https://github.com/leourbina/open-artifacts/issues/74)) ([6ac0d3b](https://github.com/leourbina/open-artifacts/commit/6ac0d3b2741ec47cdee3ab3b3e95839717f6e932))
* **server:** resilient OIDC state (TTL, per-attempt cookie, retry) ([#78](https://github.com/leourbina/open-artifacts/issues/78)) ([ea35373](https://github.com/leourbina/open-artifacts/commit/ea35373896c874632742d007a3902dc9d18b1bd5))
* **setup:** ignore EPIPE when a child exits before reading stdin ([#63](https://github.com/leourbina/open-artifacts/issues/63)) ([7dd5d92](https://github.com/leourbina/open-artifacts/commit/7dd5d92af1d5bd9cc14a14d0a71869292648a5ab))
* **setup:** valid JSON snippets and single-quoted header in agent-config ([#92](https://github.com/leourbina/open-artifacts/issues/92)) ([1a64eed](https://github.com/leourbina/open-artifacts/commit/1a64eed875329aff03f79ccf151835da47b2bcb9))
* **shared:** mocks 401 anonymous on authed routes (C1 follow-up) ([#47](https://github.com/leourbina/open-artifacts/issues/47)) ([6119700](https://github.com/leourbina/open-artifacts/commit/611970066b3cf49c4c7605806f8e0c0f88fffd91))
* staging Access policy allows everyone (spec 6.5) ([#35](https://github.com/leourbina/open-artifacts/issues/35)) ([8c9c7aa](https://github.com/leourbina/open-artifacts/commit/8c9c7aabbfe06cf2eed27359d3af2673779ecde5))
* **ui:** tabs without content add no tab stop ([bbe9da7](https://github.com/leourbina/open-artifacts/commit/bbe9da75b4f4c4f3ee17a3641c7a279d9821771d))
