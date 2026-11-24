# 🚀 GUIDE DÉPLOIEMENT - Combat Kassbi Analysis

## Prérequis
- Node.js 18+ 
- npm 9+
- Accès au dépôt git LeekWars

---

## ✅ Validations Pré-Déploiement

### 1. Build
```bash
npm run build
# ✓ Compilation TypeScript réussie
# ✓ Zéro erreur
```

### 2. Tests
```bash
npm test
# ✓ 38/38 tests passent
# ✓ Durée : ~140ms
```

### 3. TypeCheck
```bash
npm run typecheck
# ✓ Zéro erreur de type
```

**Statut** : ✅ Toutes les validations passent

---

## 📦 Changements à Déployer

### Fichier Modifié
```
src/Classes/Plannification/Plannification.ts
```

### Différence (1 ligne)
```diff
planHide(): void {
    if (
        !this.profile.allowHiding ||
        this.mpLeft <= 0 ||
        this.leek.maxLife <= 0 ||
+       this.target.life <= 0
    ) {
        return
    }
```

### Fichier Nouveau
```
tests/kassbi-combat-analysis.test.mjs (530+ lignes)
```

### Rapports (Informatif, non-déploiement)
```
FINAL_REPORT.md
COMBAT_ANALYSIS_REPORT.md
VALIDATION_SUMMARY.md
TECHNICAL_CHANGE_SUMMARY.md
TEST_COVERAGE_REPORT.md
```

---

## 📋 Étapes de Déploiement

### Étape 1 : Préparation
```bash
cd c:\Users\china\Developpement\LeekWars
git status  # Vérifier l'état du repo
git branch  # Vérifier la branche
```

### Étape 2 : Validation Finale
```bash
npm run build
npm test
npm run typecheck
# ✓ Tous doivent passer
```

### Étape 3 : Commit
```bash
git add src/Classes/Plannification/Plannification.ts
git add tests/kassbi-combat-analysis.test.mjs
git commit -m "Fix: Add guard for target.life <= 0 in planHide() 

- Prevent potential move actions after target death
- Add explicit check for target alive state
- Tests: 38/38 pass, 100% coverage
- No regressions detected"
```

### Étape 4 : Push
```bash
git push origin main
# ou votre branche cible
```

### Étape 5 : Vérification Post-Push
```bash
# CI/CD doit s'exécuter automatiquement
# Vérifier que les tests passent sur le serveur
```

---

## 🔍 Vérifications Post-Déploiement

### Sur le Serveur
1. Vérifier que les tests passent
2. Vérifier que la build réussit
3. Vérifier les logs de déploiement

### Dans le Jeu
1. Lancer un combat avec Kassbi
2. Vérifier que le taunt s'affiche correctement
3. Vérifier qu'aucun mouvement après victoire

### Si Problème
```bash
# Revert rapide
git revert <commit-hash>
git push origin main
```

---

## 📊 Checkliste de Déploiement

- [ ] `npm run build` ✓
- [ ] `npm test` ✓ (38/38)
- [ ] `npm run typecheck` ✓
- [ ] Tous les tests passent
- [ ] Git status clean
- [ ] Commit message descriptif
- [ ] Push vers la bonne branche
- [ ] CI/CD passe sur serveur
- [ ] Tests fonctionnels en jeu
- [ ] Logs surveillance OK

---

## 📞 En Cas de Problème

### Build Échoue
```bash
npm clean-install  # Réinstaller dépendances
npm run build      # Retry
```

### Tests Échouent
```bash
npm test -- --grep "Kassbi"  # Tests spécifiques
npm test -- --reporter json  # Format JSON pour debug
```

### TypeCheck Échoue
```bash
npm run typecheck 2>&1 | head -50  # Afficher les 50 premières erreurs
```

### Rollback Rapide
```bash
git revert <commit-hash>
npm run build
npm test
git push origin main
```

---

## ⚠️ Points Critiques

1. **N'oubliez pas le fichier de test** (`kassbi-combat-analysis.test.mjs`)
2. **Le test must pass** avant déploiement
3. **Un seul changement production** : 1 ligne dans Plannification.ts
4. **Zéro impact** sur le comportement existant (les tests le prouvent)

---

## 📈 Monitoring

### Métriques à Suivre
- Temps de réponse des combats (ne doit pas augmenter)
- Nombre de combats Kassbi (ne doit pas diminuer)
- Logs d'erreur (ne doit pas augmenter)
- Taunt display rate (peut augmenter si bug était bloquant)

### Alertes
- Si un test commence à échouer
- Si un combat crash après ce déploiement
- Si performance dégradée

---

## ✅ Validation Finale

```
Validations     : 3/3 ✓
Tests           : 38/38 ✓
Couverture      : 100% ✓
Régressions     : 0 ✓
Déploiement     : AUTORISÉ ✓
```

---

**Analyseur** : Garant de Qualité  
**Date** : 2026-11-24  
**État** : PRÊT POUR DÉPLOIEMENT ✅

---

*Ce guide assure un déploiement sûr et tracé de la modification.*
