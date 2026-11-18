> Historical document. Superseded on 2026-11-18: Engram is removed from the Argos product scope. See PRODUCT_MODEL.md.

# Intégration future : ArgosMCP, Engram Cloud et Telegram

Préparation du 18 novembre 2026. **Pas d’activation ni de migration dans Argos.**

Engram est un produit indépendant. Son évolution cloud est préparée dans le dépôt privé `engram/private/engram-cloud`, dans `docs/cloud-contexts/README.md` et `docs/cloud-contexts/TELEGRAM.md`, avec un contrat de permissions testé et un schéma SQL brouillon hors migrations.

## Rôles

- **Engram** stocke, indexe et recherche les mémoires. Il contrôle les contextes personnels, les contextes d’équipe et les informations explicitement publiées à toute l’entreprise.
- **Argos** contrôle les appels de l’agent : autoriser, demander une approbation ou refuser. Une approbation Argos ne remplace jamais les permissions Engram.
- **Telegram** est une source et une destination via un bot/connecteur distinct. Un MCP Telegram pourra exposer les actions de messagerie ; il ne deviendra pas une seconde base de mémoire.

## Contrat attendu

Une connexion Engram Cloud devra lier explicitement l’installation Argos, l’entreprise Engram, l’utilisateur et les contextes autorisés. L’authentification Engram et les délégations courtes restent à implémenter. Aucun rapprochement automatique par nom d’équipe ou e-mail, aucun jeton maître contenant les droits de toute l’entreprise remis à l’agent.

Les outils de mémoire recevront un `context_id` exact. Plusieurs contextes d’une même équipe auront des namespaces distincts. Engram vérifiera les droits avant la recherche et avant la livraison ; Argos appliquera en plus ses règles et expirations. Les anciens contextes locaux restent locaux tant que leur propriétaire n’a pas explicitement choisi un transfert.

## Telegram

```text
Telegram → connecteur d’ingestion → contexte Engram explicitement autorisé
Question → identité liée → agent → Argos si requis → recherche Engram limitée aux droits
Réponse → vérification des sources et des destinataires → Telegram
```

Le compte d’ingestion écrit uniquement dans les contextes liés aux chats/topics approuvés. Il ne sert pas de compte de lecture global pour répondre aux utilisateurs. Chaque demande utilise l’identité liée du demandeur et ses droits actuels.

Le bot peut alimenter les contextes de plusieurs équipes. Cela ne crée pas une mémoire globale accessible à chacun. Une question Sales ne peut pas récupérer Finance, y compris à travers un résumé, un cache ou l’historique du bot. Les messages Telegram ne peuvent pas modifier leurs propres permissions.

Les réponses privées sont prévues en premier. Une réponse dans un groupe exige une audience complète vérifiée et autorisée pour toutes les sources utilisées. Si ce contrôle est impossible, réponse privée au demandeur vérifié ou lien Engram protégé. La seule autorisation du demandeur ne permet pas une publication au groupe.

## Disponibilité

L’architecture, le schéma brouillon et les contrats de permissions sont préparés dans Engram. Les routes cloud, la délégation Argos, le moteur d’indexation isolé, la collecte Telegram et l’envoi de réponses ne sont pas encore implémentés dans ce nouveau parcours. Le comportement actuel d’Argos Personal reste inchangé.

## Mise à jour : service Engram indépendant implémenté

Le 18 novembre 2026, `engram/private/engram-cloud/workers/contexts` a été implémenté et déployé sur https://engram-contexts.leraviole.workers.dev/cloud, avec une base dédiée. Il fournit entreprises, équipes, contextes personnels/partagés, clés d’accès limitées et révocables, ingestion chiffrée, recherche textuelle et MCP. Le SDK et le template de bot Telegram sont dans `engram/public/engram-mcp`. Chaque entreprise crée son bot et conserve son token Telegram chez elle ; aucune collecte réelle n’est activée par défaut.

Cette livraison ne branche pas automatiquement Argos sur Engram et ne fournit pas encore la fédération OAuth/approbations décrite plus haut. Les clés actuelles sont liées à un utilisateur et à un seul contexte. La mémoire locale d’Argos Personal reste indépendante. Le guide opérationnel Engram décrit les limites de la première version (recherche lexicale, 1 000 identifiants par contexte, chiffrement serveur et non E2EE).
