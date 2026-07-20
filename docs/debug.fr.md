# Déboguer l'intégration OIDC eSignet — Guide pratique

*[English version →](./debug.md)*

## À qui s'adresse ce document

Vous intégrez une application web avec **eSignet** (le fournisseur d'identité OpenID Connect de MOSIP) — ou avec n'importe quel fournisseur OIDC — et vous tombez sur une erreur qui semble absurde. Ce document recense chaque bug réellement rencontré en construisant cette intégration (`esignet-backend` + `vue-upload-form`, déployés sur Render), sa cause réelle, et comment nous l'avons corrigé. Il est rédigé pour qu'un développeur junior puisse suivre le raisonnement, pas seulement copier le correctif — parce que la *prochaine* intégration rencontrera d'autres bugs, et la méthode de débogage compte plus qu'un correctif isolé.

Rien n'est hypothétique ici. Chaque problème ci-dessous s'est réellement produit, dans cet ordre exact, sur ce projet précis. Corriger l'un révélait souvent le suivant — c'est normal. Ne vous découragez pas si un correctif ne produit pas immédiatement une connexion parfaite : il produit généralement une erreur **différente, plus précise**, ce qui veut dire que vous progressez.

## Rappel d'architecture

Deux services séparés, déployés indépendamment sur Render :

- **`vue-upload-form`** — une SPA Vue 3, servie en fichiers statiques par nginx en production.
- **`esignet-backend`** — une API Express/TypeScript qui parle à eSignet côté serveur (échange de token, UserInfo) et à Postgres (via Supabase).

Cette séparation (frontend et backend sur des origines réellement différentes) est la cause de la plupart des bugs les plus difficiles ici. Une application monolithique (frontend et backend sur le même domaine) aurait évité plusieurs de ces problèmes — mais ne refléterait pas la façon dont la plupart des intégrations réelles sont déployées.

## Glossaire (à sauter si vous connaissez déjà OIDC)

| Terme | Signification |
|---|---|
| **OIDC** | OpenID Connect — une couche d'identité au-dessus d'OAuth2. Les flux « Se connecter avec X » utilisent ça. |
| **`redirect_uri`** | L'URL vers laquelle le fournisseur d'identité renvoie le navigateur après connexion. Doit être enregistrée à l'avance, caractère pour caractère. |
| **`id_token`** | Un JWT signé prouvant l'identité de l'utilisateur. Contient `sub` (identifiant utilisateur), `iss` (émetteur), `aud` (audience/client_id), `nonce`, etc. |
| **Endpoint UserInfo** | Un second endpoint qu'on appelle *après* avoir obtenu un token, pour récupérer le profil de l'utilisateur (nom, email, ...). |
| **`private_key_jwt`** | Une méthode d'authentification client où le backend signe un JWT avec sa propre clé privée au lieu d'envoyer un secret partagé. |
| **PKCS8** | Un format standard pour encoder une clé privée en texte (`-----BEGIN PRIVATE KEY-----...`). |
| **SameSite / cookies tiers** | Règles du navigateur qui restreignent quand un cookie posé par un site peut être envoyé/lu par un site différent. |
| **Public Suffix List (PSL)** | Une liste de domaines (comme `onrender.com`, `github.io`, `vercel.app`) où *chaque sous-domaine* est traité comme un site indépendant — pas seulement une origine différente. |

---

## Catégorie A — Environnement local

### A1. Port Postgres déjà utilisé

**Symptôme :** `docker compose up` n'arrivait pas à lier le port 5432.

**Cause réelle :** une autre instance Postgres (d'un projet différent) utilisait déjà ce port sur la machine de développement partagée.

**Correctif :** le conteneur a été mappé sur un autre port hôte (`POSTGRES_PORT=5435` dans `.env`, utilisé par `${POSTGRES_PORT:-5432}:5432` dans `docker-compose.yml`).

**Leçon :** ne jamais coder en dur les ports hôtes dans les fichiers Docker Compose — toujours les rendre surchargeables via une variable d'environnement avec une valeur par défaut raisonnable.

### A2. Une note de texte égarée a silencieusement cassé le parsing d'env de Docker Compose

**Symptôme :** `docker compose up` essayait de lier le conteneur *app* au port 5432 (celui de Postgres), échouant avec « address already in use » — alors que le fichier compose disait clairement `${PORT:-3000}:3000`.

**Cause réelle :** quelqu'un avait collé des notes de connexion brutes dans `.env` comme aide-mémoire :
```
PORT:5432
```
Ce n'est pas une syntaxe `CLÉ=VALEUR` valide (deux-points au lieu d'un égal), mais le parseur de fichier env de Docker Compose l'a géré différemment de ce qu'on attendait, corrompant la variable `PORT` utilisée ailleurs dans le fichier.

**Correctif :** suppression des lignes non conformes à `CLÉ=VALEUR` dans `.env`.

**Leçon :** les fichiers `.env` ne sont pas un brouillon. Une seule ligne malformée peut avoir des effets surprenants et difficiles à tracer sur des variables *sans rapport*. Gardez `.env` strictement en `CLÉ=VALEUR`, et mettez les notes en commentaires (`#`) ou dans un fichier séparé.

---

## Catégorie B — Hébergement de la base de données (Supabase)

### B1. Connexion Postgres directe inaccessible (« Can't reach database server »)

**Symptôme :** `prisma migrate deploy` (et notre propre app) n'arrivaient pas à se connecter à la chaîne de connexion directe de Supabase (`db.<ref>.supabase.co:5432`), alors que le mot de passe était correct.

**Cause réelle :** ce nom d'hôte se résout vers une adresse **IPv6 uniquement**. Supabase a retiré le support IPv4 sur l'endpoint de connexion directe par défaut (c'est maintenant une option payante). Beaucoup de réseaux/hébergeurs (y compris ce bac à sable de développement, et potentiellement certains hébergeurs) n'ont aucune sortie IPv6.

**Diagnostic :** `getent hosts <hostname>` ne montrait qu'une adresse IPv6 ; un curl brut en IPv6 a confirmé l'absence de route de sortie.

**Correctif :** bascule vers la chaîne de connexion **Session pooler** de Supabase (`aws-0-<region>.pooler.supabase.com:5432`), compatible IPv4. Le format du nom d'utilisateur change aussi : `postgres.<project-ref>` au lieu de simplement `postgres`.

**Leçon :** quand une chaîne de connexion « qui a l'air correcte » échoue avec une erreur réseau générique, vérifiez d'abord la résolution DNS (`getent hosts`, `dig`) avant de supposer un problème d'identifiants.

### B2. Erreur TLS : « self-signed certificate in certificate chain »

**Symptôme :** `prisma migrate deploy` fonctionnait (il utilise un moteur différent, plus permissif), mais le driver de base de données de l'app elle-même (`pg` via `@prisma/adapter-pg`) échouait avec une erreur de handshake TLS.

**Cause réelle :** les versions récentes du parseur de chaîne de connexion de `pg` traitent `sslmode=require` comme exigeant une *vérification complète du certificat* — plus strict que le sens traditionnel de `require` (chiffrer, mais ne pas vérifier). Le pooler de Supabase présente une chaîne de certificats qui échoue à cette vérification plus stricte.

**Correctif :** ajout de `&uselibpqcompat=true` à la chaîne de connexion, ce qui restaure le comportement traditionnel « chiffrer sans vérifier » pour `sslmode=require`.

**Leçon :** « ça marche depuis un outil mais pas depuis un autre » (ici : le CLI de Prisma contre le driver de l'app elle-même) est une catégorie de bug réelle et courante — des outils différents peuvent implémenter le « même » protocole avec des valeurs par défaut différentes. Le succès du CLI ne prouve pas que l'app fonctionnera aussi.

---

## Catégorie C — Plateforme de déploiement Render

### C1. Le Postgres géré de Render n'a pas de palier gratuit

**Symptôme :** l'application d'un Render Blueprint contenant un bloc `databases:` a soudainement demandé des informations de paiement.

**Cause réelle :** l'offre Postgres propre à Render nécessite un plan payant ; seul le service web lui-même a un palier gratuit.

**Correctif :** suppression du bloc `databases:` de `render.yaml`, utilisation de Supabase (externe, palier gratuit) à la place, avec `DATABASE_URL` comme variable d'environnement définie manuellement.

**Leçon :** vérifiez ce qui est réellement gratuit sur une plateforme avant de concevoir de l'infrastructure-as-code autour — ne supposez pas que « la plateforme a du Postgres » signifie « la plateforme a du Postgres *gratuit* ».

### C2. « New Web Service » contre « New Blueprint »

**Symptôme :** configurer manuellement un Web Service dans le tableau de bord de Render aurait nécessité de ressaisir chaque variable d'environnement à la main, deviner le chemin du Dockerfile, et créer la base de données manuellement.

**Cause réelle :** Render a deux flux de création différents. Seul « New → Blueprint » lit `render.yaml`.

**Correctif :** toujours utiliser le flux Blueprint quand un `render.yaml` existe dans le dépôt.

**Leçon :** les fichiers d'infrastructure-as-code ne servent à rien si vous n'utilisez pas le point d'entrée qui les lit réellement.

### C3. Erreurs 502 transitoires dues au démarrage à froid du palier gratuit

**Symptôme :** des `502 Bad Gateway` intermittents avec l'en-tête `x-render-routing: no-deploy`, qui se résolvaient d'eux-mêmes en quelques secondes à quelques dizaines de secondes.

**Cause réelle :** le palier gratuit de Render met les instances en veille après inactivité ; la première requête doit attendre un démarrage à froid (peut prendre 50+ secondes), et un proxy placé devant (dans notre cas, le nginx d'un service Render faisant proxy vers un autre service Render) peut expirer avant la fin du réveil.

**Correctif :** rien à corriger dans le code — c'est un comportement attendu du palier gratuit. Diagnostiqué en réessayant plusieurs fois et en constatant que ça se résolvait tout seul, et en vérifiant le backend directement (en contournant le proxy du frontend) pour voir qu'il était en bonne santé.

**Leçon :** avant d'écrire du code pour « corriger » un échec intermittent, reproduisez-le encore quelques fois. Certaines choses ne sont pas des bugs — c'est juste le palier gratuit qui se comporte comme un palier gratuit.

---

## Catégorie D — Cross-origin et cookies (la catégorie la plus difficile)

C'est la catégorie qui a pris le plus de temps à résoudre complètement, parce que chaque correctif révélait un problème *différent* dans la même zone, et la cause sous-jacente (les navigateurs traitant les sous-domaines de Render comme des « sites » séparés) n'est pas quelque chose auquel la plupart des développeurs pensent au quotidien.

### D1. Chargement du logo bloqué en cross-origin

**Symptôme :** console du navigateur : `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` en chargeant une image depuis le backend sur un site différent.

**Cause réelle :** Helmet (notre middleware d'en-têtes de sécurité) définit `Cross-Origin-Resource-Policy: same-origin` par défaut, ce qui bloque explicitement les autres origines d'intégrer la ressource (ici, en `<img>`).

**Correctif :** configuration de `crossOriginResourcePolicy: { policy: "cross-origin" }` de Helmet pour le chemin des ressources statiques — un assouplissement documenté et intentionnel, exactement pour ce cas (ressources publiques destinées à être intégrées ailleurs).

**Leçon :** les valeurs par défaut modernes des en-têtes de sécurité sont souvent *plus strictes* qu'une intégration naïve ne l'anticipe. Quand quelque chose est bloqué avec une erreur du type `NotSameOrigin`, vérifiez `Cross-Origin-Resource-Policy` avant de supposer un problème CORS (`Access-Control-Allow-Origin`) — ce sont des mécanismes différents.

### D2. Le cookie n'arrivait jamais au callback (« missing_or_expired_login_attempt ») — tentative 1

**Symptôme :** un cookie posé par un endpoint (`/prepare`) n'était jamais retrouvé par un endpoint ultérieur (`/callback`), bien que les deux soient sur le même backend.

**Cause réelle :** le frontend appelait l'endpoint `/prepare` du backend avec `credentials: "include"` (correct), mais la configuration CORS du backend n'incluait pas `credentials: true`. Les navigateurs exigent que **les deux côtés** optent explicitement pour les requêtes cross-origin avec identifiants — l'en-tête de réponse `Access-Control-Allow-Credentials: true` doit être présent, sinon le navigateur refuse de stocker/envoyer des cookies pour cette requête, peu importe ce que demande le client.

**Correctif :** ajout de `credentials: true` à la configuration du middleware `cors()`.

**Leçon :** les cookies cross-origin ont besoin de trois éléments alignés : l'attribut `SameSite` du cookie, le mode `credentials` du client, *et* l'en-tête CORS credentials du serveur. En manquer un seul casse tout silencieusement — généralement sans aucun message d'erreur, juste « le cookie n'est pas là ».

### D3. Le frontend appelait un chemin relatif qui se résolvait vers sa propre origine

**Symptôme :** l'appel `fetch` du frontend vers `/api/auth/esignet/prepare` atteignait en fait `vue-upload-form.onrender.com/api/...` — le domaine *du frontend lui-même* — pas le backend, parce que les deux sont des services Render séparés sans proxy entre eux (à ce moment-là).

**Cause réelle :** les URLs relatives dans `fetch()` se résolvent par rapport à l'origine de la *page courante*, pas vers un autre serveur, sauf si quelque chose (un proxy, une URL complète) les redirige.

**Correctif (court terme) :** utilisation directe de l'URL complète du backend (ce qui a introduit une complexité cross-origin, remplacée plus tard — voir D4).

**Leçon :** un chemin d'API relatif ne fonctionne que si le frontend et le backend partagent une origine (directement, ou via un reverse proxy). S'ils sont des services séparés, il faut soit un proxy, soit l'URL complète du backend — un chemin relatif fait silencieusement autre chose, pas rien du tout, ce qui rend ce bug sournois (ça ne fait pas un 404 évident ; ça atteint juste le mauvais serveur).

### D4. La vraie cause racine : blocage des cookies tiers via la Public Suffix List

**Symptôme :** même après avoir corrigé D2 et D3 (bons identifiants CORS, bonne URL cross-origin), le callback ne retrouvait *toujours pas* le cookie posé quelques instants plus tôt par le même navigateur.

**Cause réelle — la grosse :** `onrender.com` figure sur la **Public Suffix List**. Cela signifie que chaque sous-domaine de locataire (`vue-upload-form.onrender.com`, `esignet-backend.onrender.com`) est traité par les navigateurs comme un **site indépendant**, pas seulement une origine différente sous un domaine partagé — la même règle qui rend les sous-domaines de `github.io` ou `vercel.app` mutuellement non fiables. Un cookie posé via un appel `fetch()` d'un tel site vers un autre est un véritable **cookie tiers**, et les navigateurs modernes peuvent silencieusement refuser de le stocker — indépendamment de `SameSite`, indépendamment des en-têtes CORS. Aucun réglage d'en-tête ne corrige ça ; c'est un sous-système du navigateur différent (protection contre le tracking / dépréciation des cookies tiers) de CORS ou SameSite.

**Comment on l'a trouvé :** un avertissement dans la console du navigateur (« Chrome may soon delete state for intermediate websites in a recent navigation chain ») a mis la puce à l'oreille. Confirmé en vérifiant `curl https://publicsuffix.org/list/public_suffix_list.dat | grep onrender.com`.

**Correctif — architectural, pas un en-tête :** tout le flux OIDC a été redirigé pour passer par l'origine propre du frontend. Le nginx du frontend faisait déjà proxy de `/api/*` vers le backend (pour éviter du CORS classique) ; on a étendu ça pour aussi faire proxy de `/auth/*` (le chemin du callback), et changé `redirect_uri` pour pointer vers **le domaine propre du frontend** (`https://vue-upload-form.onrender.com/auth/callback`), pas celui du backend. nginx transmet la requête au vrai backend côté serveur — le navigateur ne sait ni ne se soucie de rien, puisqu'il ne parle jamais qu'à une seule origine, du début à la fin. Les cookies posés et lus pendant ce flux sont désormais first-party de bout en bout.

**Leçon :** c'est la leçon la plus importante de tout ce document. Si votre frontend et votre backend sont déployés comme des services séparés sous un domaine *d'hébergement* partagé (Render, Vercel, Netlify, GitHub Pages, ...), vérifiez si ce domaine figure sur la Public Suffix List avant de supposer que « même domaine parent » signifie « même site » pour les cookies. Si c'est le cas, les cookies doivent être rendus first-party via un reverse proxy — la configuration CORS et SameSite seule ne peut pas corriger le blocage des cookies tiers.

---

## Catégorie E — Particularités spécifiques à eSignet/OIDC

### E1. `redirect_uri` doit correspondre exactement à ce qui est enregistré — et à lui-même entre les étapes

**Symptôme :** la propre page d'erreur d'eSignet : *« Oups ! Il semble y avoir un problème avec l'URL. »*

**Cause réelle :** le `redirect_uri` envoyé pendant `/authorize` doit être identique, caractère pour caractère, à ce qui est enregistré auprès du fournisseur d'identité pour ce client, ET identique à ce qui est envoyé plus tard pendant l'échange de token. Quand on a changé l'architecture (D4) pour pointer `redirect_uri` vers le domaine du frontend, cette nouvelle URL n'avait pas encore été enregistrée auprès de MOSIP/ANIP.

**Correctif :** demande à l'équipe du fournisseur d'identité (ANIP) de mettre à jour le `redirect_uri` enregistré vers la nouvelle valeur. Aucun correctif de code possible — c'est de la coordination externe, pas un bug.

**Leçon :** chaque fois que vous changez `redirect_uri` (même pour une raison architecturale légitime), il faut le réenregistrer auprès du fournisseur d'identité. Prévoyez du temps pour cette étape de coordination — ce n'est pas instantané.

### E2. La clé privée a perdu ses sauts de ligne en étant collée dans un tableau de bord

**Symptôme :** `TypeError: "pkcs8" must be PKCS#8 formatted string` quand le backend essayait de signer un JWT d'assertion client.

**Cause réelle :** une clé privée PKCS8 est du texte multi-lignes. La coller dans les champs de variables d'environnement de certains tableaux de bord web peut silencieusement effondrer ou corrompre les sauts de ligne.

**Correctif :** reformatage de la clé en **une seule ligne** avec des séquences d'échappement `\n` littérales au lieu de vrais sauts de ligne, et modification du parsing des variables d'environnement de l'app pour les dé-échapper (`value.replace(/\\n/g, "\n")`). Cette forme survit au collage dans presque n'importe quel champ texte, puisqu'il n'y a rien que le champ puisse « utilement » reformater.

**Leçon :** tout secret multi-lignes (clés privées, certificats) passant par une interface web risque un endommagement des espaces/sauts de ligne. L'astuce de la ligne unique avec sauts de ligne échappés est un contournement standard et robuste — vérifiez qu'elle se parse correctement *avant* de lui faire confiance en production (on a écrit un petit script qui appelle réellement `importPKCS8()` sur la valeur pour confirmer).

### E3. Émetteur (`iss`) différent : le vrai `iss` inclut un chemin, pas juste l'hôte

**Symptôme :** `JWTClaimValidationFailed: unexpected "iss" claim value`.

**Cause réelle :** on avait configuré `ESIGNET_ISSUER=https://esignet.benin.mosip.net`, mais le véritable `id_token` reçu avait `iss: "https://esignet.benin.mosip.net/v1/esignet"` — un suffixe de chemin qu'on n'avait pas anticipé.

**Correctif :** mise à jour de `ESIGNET_ISSUER` vers la valeur exacte observée dans un vrai token décodé.

**Leçon :** ne faites pas confiance à la documentation d'un fournisseur ou à un guide d'intégration générique pour les valeurs exactes d'endpoint/émetteur — vérifiez par rapport à ce qu'un **vrai token** contient réellement. Décodez un vrai `id_token` (son payload est en base64 simple, pas chiffré) et comparez, claim par claim, avec votre configuration.

### E4. L'endpoint UserInfo ne se comporte pas comme l'id_token

**Symptôme :** `JWTClaimValidationFailed: missing required "iss" claim` — cette fois depuis la réponse *UserInfo*, pas l'id_token, qui avait déjà passé la validation.

**Cause réelle :** deux particularités réelles et distinctes de ce déploiement spécifique d'eSignet :
1. La clé de signature de sa réponse UserInfo ne correspond pas à ce que publie son propre endpoint JWKS (une limitation connue et documentée — ce qui veut dire que la signature ne peut réellement pas être vérifiée cryptographiquement).
2. Son JWT UserInfo **omet entièrement `iss` et `aud`** — contrairement à l'id_token, qui les inclut correctement.

**Correctif :** en deux parties. D'abord, un mode de compatibilité « faire confiance mais vérifier ce qui est vérifiable » (`ESIGNET_ALLOW_UNVERIFIED_USERINFO=true`) qui saute la vérification de signature mais vérifie quand même : que l'endpoint est en HTTPS et de même origine que l'émetteur, que l'algorithme est celui attendu, et que `iss`/`aud` correspondent **s'ils sont présents**. Ensuite — le vrai correctif qui a nécessité une itération de plus — cette dernière vérification a dû devenir conditionnelle (« si présent »), parce qu'on l'avait initialement écrite comme une exigence stricte, ce qui cassait sur des données réelles qui n'incluent tout simplement pas ces claims.

**Leçon :** « vérifier par rapport aux données réelles » s'applique récursivement — même votre logique de compatibilité/repli doit être testée contre la réponse réelle et désordonnée, pas seulement contre ce que la spec dit qui *devrait* être là. Deux endpoints d'apparence similaire (id_token contre UserInfo) du *même* fournisseur peuvent avoir des ensembles de claims sensiblement différents.

### E5. Une valeur de remplissage (`"nan"`) affichée comme si c'était une vraie donnée

**Symptôme :** le tableau de bord affichait `Adresse e-mail : nan`.

**Cause réelle :** eSignet envoie la chaîne littérale `"nan"` pour certains claims optionnels indisponibles ou non consentis — pas `null`, pas un champ omis, une vraie chaîne de quatre caractères. (C'est un signe classique d'un backend qui sérialise quelque part une valeur manquante issue d'un pipeline façon data-science, par exemple le `pandas.NaN` de Python, en simple chaîne de caractères.)

**Correctif :** ajout d'un petit filtre qui traite `"nan"`, `"null"`, `"undefined"`, `"none"`, et les chaînes vides (insensible à la casse) comme « pas de valeur », côté frontend là où la donnée est affichée.

**Leçon :** ne faites jamais confiance au fait qu'une donnée « absente » sera représentée par `null`/`undefined`/un champ omis. Les vraies API tierces inventent leurs propres conventions de remplissage. Filtrez de manière défensive au niveau de l'affichage, et loggez/inspectez une vraie réponse avant de supposer que vous connaissez sa forme.

---

## Une note sur la méthode de débogage, pas seulement les bugs

Dans chacun de ces cas, la technique qui a réellement trouvé la cause racine était la même : **arrêtez de deviner, allez regarder la vraie chose.**

- Ne supposez pas qu'une chaîne de connexion est correcte — résolvez le nom d'hôte et voyez quelle IP elle donne réellement.
- Ne supposez pas qu'une valeur de configuration correspond à la spec — décodez un vrai token et comparez-le, claim par claim.
- Ne supposez pas qu'un en-tête est le problème — vérifiez avec `curl -v` / `curl -sD -` ce qui est *réellement* envoyé et reçu.
- Ne supposez pas qu'un échec intermittent est un bug — reproduisez-le encore quelques fois avant d'écrire un correctif.
- Ne supposez pas que votre propre code de compatibilité/repli est correct juste parce qu'il passe le typecheck — faites-le tourner contre les données réelles et désordonnées qu'il verra effectivement en production.

## Checklist pour la prochaine intégration eSignet (ou OIDC en général)

- [ ] Vérifier si les domaines d'hébergement du frontend et du backend partagent une entrée de la Public Suffix List. Si oui, prévoir un proxy same-origin dès le départ — ne pas découvrir ça après avoir déjà construit la version cross-origin.
- [ ] Décoder un vrai `id_token` et une vraie réponse UserInfo tôt dans le projet, et comparer chaque claim à votre configuration — ne pas faire confiance à la seule documentation du fournisseur.
- [ ] Confirmer le `redirect_uri` exact enregistré auprès du fournisseur d'identité avant d'écrire du code qui en suppose un autre.
- [ ] Tester les secrets multi-lignes (clés privées) à travers le tableau de bord/système CI qui les hébergera réellement, avant de déployer — vérifier qu'ils se parsent, ne pas juste le supposer.
- [ ] Vérifier si l'offre de « base de données gérée » de votre plateforme d'hébergement est réellement gratuite avant de concevoir votre architecture autour.
- [ ] Écrire la configuration CORS + cookies (`credentials`, `SameSite`, `Access-Control-Allow-Credentials`) comme une décision délibérée et documentée — pas par essais-erreurs ligne par ligne.
