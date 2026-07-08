import { type SimpleType, typeToString } from "ts-simple-type";
import { type Type, type TypeChecker, type TypeReference } from "typescript";
import { HtmlNodeAttr } from "../../../analyze/types/html-node/html-node-attr-types.js";
import { RuleModuleContext } from "../../../analyze/types/rule/rule-module-context.js";
import { rangeFromHtmlNodeAttr } from "../../../analyze/util/range-util.js";
import { isAssignableBindingUnderSecuritySystem } from "./is-assignable-binding-under-security-system.js";
import { isAssignableToType } from "./is-assignable-to-type.js";
import { type ExtractedBindingTypes } from "./extract-binding-types.js";

// Subset of the TypeChecker API that only exists on newer TypeScript versions.
// When present, we prefer it: it is cycle-safe and always matches the running
// compiler, so it sidesteps ts-simple-type's recursive-type limitations.
interface ModernTypeChecker extends TypeChecker {
	isTypeAssignableTo(source: Type, target: Type): boolean;
	getUnionType(types: Type[]): Type;
	getAnyType(): Type;
}

function isModernTypeChecker(checker: Partial<ModernTypeChecker>): checker is ModernTypeChecker {
	return typeof checker.isTypeAssignableTo === "function" && typeof checker.getUnionType === "function" && typeof checker.getAnyType === "function";
}

function isTypeScriptType(type: Type | SimpleType | undefined): type is Type {
	return type !== undefined && typeof (type as Type).flags === "number";
}

export function isAssignableInPropertyBinding(
	htmlAttr: HtmlNodeAttr,
	{ typeA, typeB, rawTypeA, rawTypeB }: ExtractedBindingTypes,
	context: RuleModuleContext
): boolean | undefined {
	const securitySystemResult = isAssignableBindingUnderSecuritySystem(htmlAttr, { typeA, typeB }, context);
	if (securitySystemResult !== undefined) {
		// The security diagnostics take precedence here,
		//   and we should not do any more checking.
		return securitySystemResult;
	}

	// typeA / rawTypeA is the binding *target* (the property type);
	// typeB / rawTypeB is the *source* (the bound expression value).
	let isAssignable: boolean | undefined;
	let sourceString: string | undefined;
	let targetString: string | undefined;
	const checker = context.program.getTypeChecker();

	let usedNativeChecker = false;
	if (isTypeScriptType(rawTypeA) && isTypeScriptType(rawTypeB) && isModernTypeChecker(checker)) {
		// Both ends are real ts.Types and the checker exposes the native API:
		// delegate assignability to TypeScript itself rather than converting to
		// SimpleType (which is where deeply recursive types overflow the stack).
		try {
			const source = removeSpecialLitSymbols(rawTypeB, checker);
			isAssignable = checker.isTypeAssignableTo(source, rawTypeA);
			if (!isAssignable && hasUnresolvedTypeParameters(rawTypeA, checker, context.ts, new Set())) {
				// We'd ideally reify the generic target to ensure multiple bindings are
				// mutually consistent and constraints are satisfied. For now, allow it.
				isAssignable = true;
			}
			if (!isAssignable) {
				sourceString = checker.typeToString(source);
				targetString = checker.typeToString(rawTypeA);
			}
			usedNativeChecker = true;
		} catch (err) {
			// TypeScript 6 has known checker recursion bugs (instantiateTypeWithAlias
			// chain) that can overflow the stack on otherwise-routine assignability
			// checks against alias-bearing union targets. Fall through to the SimpleType
			// path so the analyzer remains usable on real consumer code under TS 6.
			if (!(err instanceof RangeError)) {
				throw err;
			}
		}
	}
	if (!usedNativeChecker) {
		isAssignable = isAssignableToType({ typeA, typeB }, context);
		if (!isAssignable) {
			sourceString = typeToString(typeB);
			targetString = typeToString(typeA);
		}
	}

	if (!isAssignable) {
		context.report({
			location: rangeFromHtmlNodeAttr(htmlAttr),
			message: `Type '${sourceString}' is not assignable to '${targetString}'`
		});

		return false;
	}

	return true;
}

/**
 * Returns true if the type is the `nothing` or `noChange` unique symbol, or a
 * `DirectiveResult` — values that are always permitted in any binding.
 */
function isAlwaysAllowedLitValue(type: Type): boolean {
	if (!type.symbol) {
		return false;
	}
	const name = type.symbol.escapedName;
	if (name !== "noChange" && name !== "nothing" && name !== "DirectiveResult") {
		return false;
	}
	const declarations = type.symbol.getDeclarations();
	let declaredInLit = false;
	if (declarations != null) {
		for (const declaration of declarations) {
			if (declaration.getSourceFile().fileName.includes("/lit-html/")) {
				declaredInLit = true;
				break;
			}
		}
	}
	if (!declaredInLit) {
		return false;
	}
	if (name === "DirectiveResult") {
		// Future enhancement: get the return type of the directive's render method
		// and check that against the binding type.
		return true;
	}
	// The type must be a unique symbol.
	return (type.flags & 8192) /* ts.TypeFlags.UniqueESSymbol */ !== 0;
}

/**
 * Returns `type` with any special Lit values removed: `nothing` becomes `any`,
 * and `string | null | nothing` becomes `string | null`.
 */
function removeSpecialLitSymbols(type: Type, checker: ModernTypeChecker): Type {
	if (isAlwaysAllowedLitValue(type)) {
		// Assignable to anything.
		return checker.getAnyType();
	}
	// Otherwise just remove special values from unions.
	if (!type.isUnion()) {
		return type;
	}
	if (!type.types.some(isAlwaysAllowedLitValue)) {
		return type;
	}
	const newUnion = type.types.filter(t => !isAlwaysAllowedLitValue(t));
	if (newUnion.length === 0) {
		// Was a union of only special values, so behave like a lone special value.
		return checker.getAnyType();
	}
	if (newUnion.length === 1) {
		return newUnion[0];
	}
	return checker.getUnionType(newUnion);
}

/**
 * Does the given type reference any unresolved type parameters? e.g. `Array<string>`
 * returns false, but `Array<T>` (where `T` is a class type parameter) returns true.
 */
function hasUnresolvedTypeParameters(type: Type, checker: ModernTypeChecker, ts: typeof import("typescript"), visited: Set<Type>): boolean {
	if (visited.has(type)) {
		return false;
	}
	visited.add(type);

	// The type itself is an unresolved type parameter, i.e. just `T`.
	if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
		return true;
	}

	// Unions (`string | T`) and intersections (`string & T`).
	if (type.isUnion() || type.isIntersection()) {
		return type.types.some(t => hasUnresolvedTypeParameters(t, checker, ts, visited));
	}

	// Type arguments, like `Array<T>`.
	const typeArgs = (type as Partial<TypeReference>).typeArguments;
	if (typeArgs != null && typeArgs.some(t => hasUnresolvedTypeParameters(t, checker, ts, visited))) {
		return true;
	}

	// Call signatures, like `{ (x: T): string }` or `{ (x: string): T }`.
	for (const signature of type.getCallSignatures()) {
		if (signature.typeParameters != null) {
			return true;
		}
		for (const param of signature.parameters) {
			if (hasUnresolvedTypeParameters(checker.getTypeOfSymbol(param), checker, ts, visited)) {
				return true;
			}
		}
		if (hasUnresolvedTypeParameters(signature.getReturnType(), checker, ts, visited)) {
			return true;
		}
	}

	// Properties, like `{ x: T }`.
	for (const property of type.getProperties()) {
		if (hasUnresolvedTypeParameters(checker.getTypeOfSymbol(property), checker, ts, visited)) {
			return true;
		}
	}

	// Index signatures, like `{ [key: string]: T }`.
	for (const indexInfo of checker.getIndexInfosOfType(type)) {
		if (hasUnresolvedTypeParameters(indexInfo.keyType, checker, ts, visited) || hasUnresolvedTypeParameters(indexInfo.type, checker, ts, visited)) {
			return true;
		}
	}

	return false;
}
