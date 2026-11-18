> Historical document. Superseded on 2026-11-18: Engram is removed from the Argos product scope. See PRODUCT_MODEL.md.

# EngramMCP et les modes d’hébergement d’Argos

**EngramMCP fonctionne actuellement comme une mémoire locale, accessible à tes IA à travers ArgosMCP.** Il est intégré à Argos Personal ; ce n’est pas encore un service de mémoire cloud autonome.

Ton contexte **« My memory »** est personnel et stocké chiffré sur ton Mac. La clé de chiffrement est protégée par le trousseau macOS.

Le parcours est le suivant :

```text
Ton IA → ArgosMCP vérifie les droits → Argos Personal consulte la mémoire
       ←               résultat autorisé               ←
```

Pour l’utiliser :

1. Dans **Argos Personal → Connections**, crée une mémoire **Only me** ou **My team**. Un contexte d’équipe doit être créé par un administrateur appartenant à cette équipe.
2. Dans le dashboard, autorise ton agent à accéder à cette connexion.
3. Branche l’agent sur `<URL de ton espace>/mcp`, ou `/mcp/engram` pour n’exposer que la mémoire.

L’IA dispose de trois outils :

| Outil | Utilité |
|---|---|
| `engram_remember` | Enregistrer une information |
| `engram_recall` | Retrouver les passages pertinents |
| `engram_forget` | Supprimer une information |

**Il ne capture pas automatiquement toutes tes conversations.** L’agent doit explicitement enregistrer les informations. La recherche actuelle utilise BM25, une recherche textuelle classée par pertinence, sans embeddings ni synchronisation automatique de Slack/Notion.

Pour une mémoire d’équipe, tous les membres autorisés utilisent **la mémoire du même appareil hôte**. Cet appareil doit rester allumé. Il n’y a pas encore de réplication entre ordinateurs ni d’Engram hébergé côté serveur. La séparation actuelle est par entreprise, personne ou équipe ; les noms des connexions ne créent pas des mémoires indépendantes par projet.

**Pour Argos dans son ensemble, on a deux choix indépendants : qui héberge le backend et où restent les jetons OAuth.** Cela donne quatre combinaisons :

| Solution | Backend et règles | Jetons et exécution des outils | Ordinateur utilisateur nécessaire |
|---|---|---|---|
| **Hébergé + local** | Chez Argos | Sur chaque ordinateur, via Argos Personal | Oui |
| **Hébergé + coffre serveur** | Chez Argos | Sur le backend Argos | Non, pour les connexions serveur |
| **Auto-hébergé + local** | Chez l’entreprise | Sur chaque ordinateur | Oui |
| **Auto-hébergé + coffre serveur** | Chez l’entreprise | Sur son propre backend | Non, pour les connexions serveur |

Ces choix peuvent **coexister dans une entreprise**, connexion par connexion. Le coffre serveur exige l’activation par l’opérateur, l’accord de l’administrateur et le consentement de l’utilisateur. Son opérateur peut déchiffrer les jetons.

Le **dashboard reste notre service privé**, y compris avec un backend auto-hébergé : l’entreprise sert notre interface à sa propre adresse, et ses connexions Google, appels API et résultats restent sur son backend. Elle peut figer la version du dashboard.

Le **backend et le runtime local sont open source**. L’auto-hébergement est prévu via Docker ou Node, avec une installation et une base distinctes par entreprise. Une entreprise peut également construire sa propre interface autour du backend.

Aujourd’hui, LeRavio utilise **backend hébergé + stockage local**. C’est l’option mise en avant. Le coffre serveur existe pour Slack/Notion/Linear selon leur configuration OAuth ; **Engram reste local dans les quatre scénarios pour l’instant**.

## Évolution préparée : Engram Cloud et Telegram

Engram Cloud reste un autre produit. La préparation prévoit des contextes personnels, plusieurs contextes par équipe et des informations explicitement partagées avec toute l’entreprise. La mémoire cloud d’une équipe pourra être interrogée sans laisser allumé l’ordinateur de son créateur, avec un mode de traitement et de chiffrement annoncé clairement.

Un bot/connecteur Telegram distinct pourra enregistrer les messages de sources approuvées dans les contextes Engram correspondants. L’agent récupérera ensuite le contexte de Telegram via **EngramMCP**, avec les droits de l’utilisateur qui pose la question. Un **MCP Telegram** éventuel servira aux actions de messagerie.

Le bot pourra alimenter plusieurs contextes de l’entreprise, mais ne pourra pas divulguer Finance à Sales ou une mémoire personnelle à toute l’équipe. Les droits seront contrôlés avant la recherche, puis avant la livraison. Une réponse dans un groupe nécessitera aussi de vérifier les droits des destinataires ; à défaut, la réponse sensible restera en privé.

Cette évolution est **préparée, pas activée**. Voir [le contrat d’intégration Engram Cloud / Telegram](ENGRAM_CLOUD_INTEGRATION.md). Le dossier de conception principal et les contrats testés sont dans le projet distinct `engram/private/engram-cloud/docs/cloud-contexts/`.
