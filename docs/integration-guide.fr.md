# Guide d'intégration OIDC eSignet — Architecture frontend/backend séparée

*[English version →](./integration-guide.md)* · *Voir aussi : [debug.fr.md](./debug.fr.md) pour les bugs rencontrés en construisant tout ça.*

## Pourquoi ce document existe

Les guides d'intégration eSignet génériques (y compris la documentation de référence de MOSIP elle-même) supposent une application monolithique — frontend et backend sur le même domaine. Ce n'est pas ainsi que fonctionnent la plupart des déploiements réels : une SPA Vue/React sur un hôte, une API sur un autre. Ce guide documente la **configuration exacte et fonctionnelle** pour cette architecture séparée, telle que construite et vérifiée face à un vrai déploiement eSignet en production (`esignet.benin.mosip.net`). Chaque valeur, endpoint et particularité ici a été confirmé face à de vrais tokens et de vraies réponses d'API — pas recopié depuis une documentation.

Si vous démarrez une nouvelle intégration eSignet avec une architecture séparée similaire, c'est la référence à suivre. Si quelque chose ici ne correspond pas à ce que vous observez, faites confiance à votre propre observation plutôt qu'à ce document — les fournisseurs évoluent, et ceci reflète un instant T.

## 1. Architecture

```
                    ┌─────────────────────────┐
  Navigateur citoyen│  vue-upload-form (nginx) │
                    │  SPA statique + proxy    │
                    │  inverse pour /api/* et  │
                    │  /auth/*                 │
                    └───────────┬─────────────┘
                                │ proxifié côté serveur
                                ▼
                    ┌─────────────────────────┐
                    │  esignet-backend         │
                    │  (Express/TypeScript)    │
                    │  - logique client OIDC   │
                    │  - émission de session   │
                    │  - accès Postgres        │
                    └───────────┬─────────────┘
                                │
                    ┌───────────┴─────────────┐
                    │  Supabase Postgres        │
                    └───────────────────────────┘

                    ┌─────────────────────────┐
                    │  esignet.benin.mosip.net │
                    │  (eSignet MOSIP, IdP OIDC)│
                    └─────────────────────────┘
```

Deux services déployés indépendamment (Render, dans notre cas), plus le fournisseur d'identité et la base de données. **Le navigateur ne parle jamais qu'à l'origine propre du frontend.** Cette décision de conception unique est celle autour de laquelle tout le reste de ce guide est construit — voir §3.

## 2. Prérequis — ce qu'il faut obtenir de MOSIP/ANIP

Avant d'écrire le moindre code, il faut obtenir, de la part de qui gère l'enregistrement des clients eSignet :

| Élément | Notes |
|---|---|
| `client_id` | Identifie votre app auprès d'eSignet. |
| `redirect_uri` enregistré | **Doit être l'origine propre de votre frontend** + `/auth/callback` (ex. `https://votre-app.example.com/auth/callback`), pas le domaine du backend. Voir §3 pour comprendre pourquoi. Si vous ne connaissez pas encore le domaine de production final, enregistrez-le une fois que vous l'avez — ne devinez pas. |
| Scopes/claims approuvés | ex. `openid profile email phone`, plus les claims spécifiques (`name`, `picture`, `birthdate`, `gender`, `phone_number`, `address`, `individual_id`, ...) que votre client est autorisé à demander. Demander un claim non approuvé ne génère pas d'erreur — il revient simplement vide, silencieusement. |
| Confirmation de la méthode d'authentification client | Ce déploiement utilise `private_key_jwt` (RS256) — votre backend signe un JWT avec sa propre clé au lieu d'envoyer un secret partagé. |

Vous générez vous-même la paire de clés RSA (voir §4) et n'envoyez que la moitié **publique** pour enregistrement.

## 3. Pourquoi redirect_uri doit être le domaine propre du frontend

C'est la décision architecturale la plus importante de toute cette intégration, et celle qu'un guide générique a le plus de chances de manquer.

**Le problème :** si votre frontend et votre backend sont des services séparés sous un domaine *d'hébergement* partagé (`onrender.com` de Render, `vercel.app` de Vercel, `github.io` de GitHub, `netlify.app` de Netlify, ...), vérifiez si ce domaine figure sur la [Public Suffix List](https://publicsuffix.org/list/). Si oui, chaque sous-domaine de locataire est traité par les navigateurs comme un **site indépendant**, pas seulement une origine différente. Un cookie posé via un appel `fetch()` cross-site depuis votre frontend directement vers votre backend est un cookie tiers, et les navigateurs modernes peuvent silencieusement refuser de le stocker — ça casse à la fois le cookie CSRF de pré-connexion et le cookie de session post-connexion, sans message d'erreur utile (ça a juste l'air que « le cookie n'est pas là »).

**Le correctif :** rendre tout le flux OIDC — pas seulement vos appels API habituels — same-origin du point de vue du navigateur :

1. Le serveur web du frontend (nginx, dans notre cas) fait un reverse proxy à la fois de `/api/*` (vos appels API habituels) et de `/auth/*` (le callback OIDC) vers le backend.
2. `redirect_uri` (à la fois `VITE_ESIGNET_REDIRECT_URI` côté frontend et `ESIGNET_REDIRECT_URI` côté backend — ils doivent être identiques caractère pour caractère) est réglé sur **le domaine propre du frontend** : `https://<domaine-frontend>/auth/callback`.
3. Quand eSignet redirige le navigateur après la connexion, il atterrit sur l'origine propre du frontend. nginx transmet cette requête spécifique au vrai backend côté serveur, de façon transparente. Le navigateur ne sait jamais qu'un autre serveur a traité la requête — il ne voit jamais qu'une seule origine, du début à la fin. Chaque cookie posé ou lu pendant le flux est first-party.

```nginx
# nginx.conf (frontend) — les deux proxifiés vers le même backend
location /api/ {
    proxy_pass http://backend-host:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /auth/ {
    proxy_pass http://backend-host:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Si votre plateforme n'implique pas du tout un domaine sur la Public Suffix List (c'est-à-dire que frontend et backend partagent réellement un domaine enregistrable, comme `app.example.com` et `api.example.com` tous deux sous `example.com`), vous pouvez ignorer ceci et appeler le backend directement en cross-origin avec du CORS standard (`Access-Control-Allow-Credentials: true` + un `Access-Control-Allow-Origin` spécifique, non générique) — mais vérifiez cette hypothèse avant de vous y fier.

## 4. Générer la paire de clés du client

Le client s'authentifie auprès de l'endpoint de token avec un JWT signé (`private_key_jwt`), pas un secret partagé.

```bash
npm run esignet:generate-key
```

Ceci génère une paire de clés RSA 2048 bits (RS256), lui assigne un `kid` aléatoire, et produit :
- Une JWK **publique** (`esignet-public-jwk.json`) — à envoyer à l'équipe MOSIP/eSignet pour enregistrement.
- Une clé **privée** (PEM PKCS8) — à coller dans `ESIGNET_PRIVATE_KEY`, jamais commitée.

**Coller une clé privée multi-lignes dans un tableau de bord web (Render, ou similaire) est un point de défaillance connu.** Les sauts de ligne peuvent être silencieusement effondrés. Reformatez la clé en une seule ligne avec des séquences d'échappement `\n` littérales au lieu de vrais sauts de ligne :

```
-----BEGIN PRIVATE KEY-----\nMIIEvAIB...\n-----END PRIVATE KEY-----
```

Votre code de parsing des variables d'environnement doit dé-échapper ceci (`value.replace(/\\n/g, "\n")`). Vérifiez qu'elle se parse réellement avant de lui faire confiance en production :

```js
import { importPKCS8 } from "jose";
await importPKCS8(keyString.replace(/\\n/g, "\n"), "RS256"); // lève une erreur si malformée
```

## 5. Référence des variables d'environnement

### Frontend (au build — Vite `VITE_*`, intégrées au bundle JS)

| Variable | Valeur réelle / exemple | Notes |
|---|---|---|
| `VITE_ESIGNET_CLIENT_ID` | *(depuis l'onboarding)* | |
| `VITE_ESIGNET_REDIRECT_URI` | `https://<domaine-frontend>/auth/callback` | **Domaine propre du frontend**, pas celui du backend. Voir §3. |
| `VITE_ESIGNET_AUTHORIZE_URI` | `https://esignet.benin.mosip.net/authorize` | |
| `VITE_ESIGNET_SCOPE` | `openid profile email phone` | |
| `VITE_ESIGNET_ACR_VALUES` | *(optionnel)* | |
| `VITE_API_BASE_URL` | *(vide)* | Laissé vide pour que les appels API utilisent des chemins relatifs, proxifiés en same-origin. Ne **pas** le régler sur l'URL du backend. |

### Backend (secrets/config serveur uniquement)

| Variable | Valeur réelle / exemple | Notes |
|---|---|---|
| `ESIGNET_CLIENT_ID` | *(identique à celui du frontend)* | |
| `ESIGNET_PRIVATE_KEY` | PEM PKCS8, une ligne, `\n` échappés | Voir §4. |
| `ESIGNET_KEY_ID` | *(le `kid` de la génération de clé)* | |
| `ESIGNET_SESSION_SECRET` | 32+ caractères aléatoires | Signe **notre propre** cookie de session — sans rapport avec les clés d'eSignet. |
| `ESIGNET_ISSUER` | `https://esignet.benin.mosip.net/v1/esignet` | **Inclut le chemin `/v1/esignet`** — vérifié face au claim `iss` d'un vrai `id_token`. Ne supposez pas que c'est juste l'hôte nu. |
| `ESIGNET_TOKEN_URL` | `https://esignet.benin.mosip.net/v1/esignet/oauth/v2/token` | |
| `ESIGNET_USERINFO_URL` | `https://esignet.benin.mosip.net/v1/esignet/oidc/userinfo` | |
| `ESIGNET_JWKS_URL` | `https://esignet.benin.mosip.net/.well-known/jwks.json` | |
| `ESIGNET_REDIRECT_URI` | `https://<domaine-frontend>/auth/callback` | Doit être identique, caractère pour caractère, à la valeur du frontend. |
| `ESIGNET_ALLOW_UNVERIFIED_USERINFO` | `true` | **Requis à true face à ce déploiement spécifique** — voir §6.4. |

## 6. Le flux de connexion, étape par étape

1. **L'utilisateur clique sur « Continuer avec eSignet »** sur le frontend. Avant d'afficher le bouton officiel de connexion MOSIP (`sign-in-button-plugin.js`), le frontend appelle `GET /api/auth/esignet/prepare`.
2. **Le `/prepare` du backend** génère `state` et `nonce` (24 octets aléatoires chacun), les stocke (en JSON encodé base64url) dans un cookie httpOnly (`esignet_oauth`, `SameSite=Lax`, expiration 10 minutes), et retourne `{state, nonce}` en JSON.
3. **Le frontend initialise le bouton eSignet** avec `oidcConfig: { ...configClient, state, nonce, prompt: "consent" }`. Cliquer dessus fait naviguer le navigateur (au niveau supérieur) vers l'endpoint `/authorize` d'eSignet — une vraie navigation de page, pas un fetch.
4. **L'utilisateur s'authentifie chez eSignet** (OTP, mot de passe, biométrie, ...) et consent aux claims demandés, sur les pages hébergées par eSignet lui-même.
5. **eSignet redirige le navigateur** vers `redirect_uri?code=...&state=...` (ou `?error=...` si l'utilisateur a annulé/refusé).
6. **Le `GET /auth/callback` du backend** :
   - Lit et efface le cookie `esignet_oauth`.
   - Compare le paramètre de requête `state` à la valeur stockée dans le cookie (vérification CSRF) — différence ou cookie absent → rejet.
   - Échange `code` contre des tokens : `POST` vers l'endpoint de token avec `grant_type=authorization_code`, le même `redirect_uri`, et un JWT `client_assertion` signé (RS256, `aud` = URL de l'endpoint de token, expiration 5 minutes, `jti` unique).
   - Vérifie l'`id_token` retourné : signature face au JWKS, `iss` et `aud` correspondent à la config, et `nonce` correspond à la valeur de l'étape 2 (cette dernière vérification est ce qui lie réellement le callback à *cette* tentative de connexion — signature/émetteur/audience seuls n'empêchent pas la réutilisation d'une paire code+state volée depuis une autre session).
   - Récupère `UserInfo` avec le token d'accès — voir §6.4 pour les particularités spécifiques de ce déploiement.
   - Fait un upsert d'une ligne `User` locale indexée sur `sub` (l'identité eSignet stable — ne jamais indexer sur l'email, qui peut être absent ou changer), en stockant chaque claim consenti dans une colonne JSON `profile` générique (pas une colonne par claim possible — les nouveaux types de claims n'ont alors besoin d'aucun changement de schéma).
   - Émet notre propre session (un JWT signé HS256 contenant l'identifiant utilisateur local, dans un cookie httpOnly `session`), et redirige vers `/dashboard` sur le frontend.
7. **Le `/dashboard` du frontend** appelle `GET /api/auth/me` au montage ; si 401, redirige vers `/login?esignet_required=1`. Sinon, affiche ce qui se trouve dans `profile`.

### 6.4 Particularités spécifiques à UserInfo (ce déploiement)

Deux constats réels et vérifiés qu'un guide générique ne vous dirait pas :

- **La clé de signature des réponses UserInfo ne correspond pas au JWKS publié par ce déploiement.** La signature ne peut réellement pas être vérifiée cryptographiquement. `ESIGNET_ALLOW_UNVERIFIED_USERINFO=true` est requis, pas optionnel, face à `esignet.benin.mosip.net`.
- **Le JWT UserInfo omet entièrement `iss` et `aud`** — contrairement à l'id_token, qui les inclut correctement tous les deux. Toute logique de validation qui traite `iss`/`aud` comme requis sur UserInfo (en calquant les vérifications plus strictes de l'id_token) échouera sur des données réelles. Ne les vérifiez que s'ils sont présents.

Puisque la vérification de signature est ignorée, « faire confiance mais vérifier ce qui est vérifiable » s'applique à la place :
- L'endpoint UserInfo doit être en HTTPS et de même origine que l'émetteur.
- L'en-tête `alg` du JWT doit quand même être le `RS256` attendu (rejeter tout autre algorithme).
- `iss`/`aud`, s'ils sont présents, doivent quand même correspondre.

- **Certains claims optionnels reviennent sous la forme de la chaîne littérale `"nan"`**, ni `null` ni omis, quand ils sont indisponibles ou non consentis. Filtrez-les à l'affichage — ne supposez pas qu'« absent » veut dire `null`/`undefined`.

## 7. Session et déconnexion

| Cookie | Posé par | Contenu | Durée de vie |
|---|---|---|---|
| `esignet_oauth` | `/api/auth/esignet/prepare` | `{state, nonce}`, JSON base64url | 10 minutes ; effacé inconditionnellement par le callback (succès ou échec) |
| `session` | `/auth/callback` (en cas de succès) | JWT signé, identifiant utilisateur local uniquement | 7 jours |

La déconnexion (`GET/POST /api/auth/esignet/logout`) expire les deux cookies et redirige vers `/login`. Elle est conçue pour être déclenchée par une vraie navigation du navigateur (`window.location.href`), pas un `fetch()` — un fetch ne peut pas produire la redirection qui fait réellement naviguer le navigateur ailleurs.

Le document de découverte de ce déploiement eSignet ne publie aucun `end_session_endpoint` connu — la déconnexion est locale à cette app uniquement, pas une déconnexion globale d'eSignet.

## 8. Déploiement (Render)

Les deux services se déploient via des Blueprints `render.yaml` (**utilisez « New → Blueprint » dans le tableau de bord de Render, pas « New → Web Service »** — seul le flux Blueprint lit `render.yaml`).

- **Base de données :** le Postgres géré propre à Render n'a pas de palier gratuit. On utilise Supabase à la place. Deux pièges spécifiques à Supabase :
  - Utiliser la chaîne de connexion **Session pooler** (`aws-0-<region>.pooler.supabase.com:5432`), pas la directe (`db.<ref>.supabase.co`) — la directe est IPv6 uniquement et inaccessible depuis beaucoup de réseaux.
  - Ajouter `&uselibpqcompat=true` à la chaîne de connexion en plus de `sslmode=require` — sinon `pg` traite `sslmode=require` comme exigeant une vérification complète du certificat, ce qui échoue face à la chaîne de certificats de Supabase.
- **Démarrages à froid du palier gratuit :** les deux services peuvent se mettre en veille après inactivité ; une requête peut transitoirement faire un 502 pendant qu'une instance se réveille (jusqu'à ~50s). C'est attendu, pas un bug — ne le traquez pas comme tel.

## 9. Référence des endpoints réels — esignet.benin.mosip.net

Confirmé face au document de découverte de ce déploiement et à de vrais tokens :

| Élément | Valeur |
|---|---|
| Émetteur (issuer) | `https://esignet.benin.mosip.net/v1/esignet` |
| Endpoint d'autorisation | `https://esignet.benin.mosip.net/authorize` |
| Endpoint de token | `https://esignet.benin.mosip.net/v1/esignet/oauth/v2/token` |
| Endpoint UserInfo | `https://esignet.benin.mosip.net/v1/esignet/oidc/userinfo` |
| JWKS | `https://esignet.benin.mosip.net/.well-known/jwks.json` |
| Type de réponse | `code` |
| Authentification client | `private_key_jwt`, RS256 |
| Algorithme de signature id_token / UserInfo | RS256 (signature UserInfo non vérifiable en pratique — voir §6.4) |
| Type de sujet | `pairwise` |
| Scopes publiés | `profile`, `email`, `phone` (plus `openid`, toujours requis) |
| Claims publiés | `name`, `address`, `gender`, `birthdate`, `picture`, `email`, `phone_number`, `individual_id`, etc. |

## 10. Référence rapide de dépannage

Pour l'histoire complète derrière chacun de ces points, voir [debug.fr.md](./debug.fr.md).

| Symptôme | Cause probable |
|---|---|
| `missing_or_expired_login_attempt` au callback | Le cookie n'a pas survécu jusqu'au callback — vérifier `credentials: true` en CORS, vérifier que `VITE_API_BASE_URL` ne pointe pas en cross-site, vérifier si votre domaine d'hébergement est sur la Public Suffix List (§3). |
| Page d'erreur propre à eSignet « problème avec l'URL » | `redirect_uri` ne correspond pas à ce qui est enregistré. |
| `TypeError: "pkcs8" must be PKCS#8 formatted string` | Sauts de ligne de la clé privée corrompus en collant dans un tableau de bord — voir §4. |
| `JWTClaimValidationFailed: unexpected "iss" claim value` | `ESIGNET_ISSUER` ne correspond pas au vrai token — décoder un vrai `id_token` et vérifier. |
| `JWTClaimValidationFailed: missing required "iss" claim` (depuis UserInfo, pas l'id_token) | Attendu sur ce déploiement — voir §6.4 ; ne pas exiger `iss`/`aud` sur UserInfo. |
| Un claim s'affiche comme le texte littéral `nan` | Filtrer les valeurs de remplissage à l'affichage — voir §6.4. |
| Logo/image bloqué en cross-origin (`NotSameOrigin`) | `Cross-Origin-Resource-Policy: same-origin` par défaut de Helmet — l'assouplir pour les ressources publiques. |
